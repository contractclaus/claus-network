import { digest, requireThat } from '../src/shared/index.mjs';

// Transport-neutral worker. Production must provide an admitted, budgeted
// dispatcher with durable same-ID transactions. Neither API credentials nor
// this worker contain a signing key. The separate hosted entry requires an
// explicit deployment pin, reviewed admission and bounded spending grant.
export function createContractIntakeWorker({ store, intake, chain, delivery, startBlock,
  enabled = async () => false, now = () => Date.now() }) {
  requireThat(Number.isSafeInteger(startBlock) && startBlock >= 1, 'invalid_start_block');
  return { async tick() {
    let active = false, disabledReason = null;
    try { active = await enabled() === true; }
    catch (error) {
      // Removing an admission stops new work, but an old signing host must
      // still account for already-broadcast transactions under its old pin.
      if (!['intake_admission_changed', 'intake_review_not_admitted', 'intake_projects_not_admitted',
        'chain_public_not_enabled', 'chain_admission_changed', 'chain_scope_not_reviewed'].includes(error.code)) throw error;
      disabledReason = error.code;
    }
    const profile = await chain.profile();
    const id = digest({ chainId: profile.chainId, inbox: profile.inbox, codeHash: profile.codeHash });
    // Reconcile existing results before scanning untrusted public traffic.
    const scan = await store.read('contract-delivery-cursors', id);
    const rows = await store.list('contract-requests', { after: scan?.value.after ?? '', limit: 100 });
    let delivered = 0, deferred = 0;
    for (const row of rows) {
      const request = row.value;
      if (request.delivery?.retryAt > now()) { deferred++; continue; }
      if (request.state !== 'result_ready' || ['delivered', 'closed', 'failed'].includes(request.delivery?.state)) continue;
      if (request.observation?.chainId !== profile.chainId ||
        request.observation?.inbox?.toLowerCase() !== profile.inbox.toLowerCase() ||
        request.observation?.codeHash !== profile.codeHash) continue;
      if (!delivery) continue;
      // The dispatcher independently verifies onchain state, immutable result,
      // expiry and its current spending mandate. It must reconcile old writes
      // even after that mandate is revoked; it must never replace unknown txs.
      let outcome;
      try {
        outcome = await delivery.step({ id: digest({ requestId: request.id, action: 'result-delivery' }), request,
          allowSubmit: active });
      } catch (error) {
        // A later row can own the pending wallet transaction. Keep walking so
        // its settlement can release the slot and reserved budget; never make
        // replenishment or a new transaction necessary to reconcile old work.
        if (!['wallet_busy', 'dispatch_budget_exhausted', 'dispatch_project_budget_exhausted', 'transaction_cost_limit',
          'transaction_not_authorized'].includes(error.code)) throw error;
        await store.transaction(async tx => {
          const current = await tx.read('contract-requests', request.id);
          await tx.write('contract-requests', request.id, { ...current.value, delivery: {
            state: 'pending', resultHash: digest(request.result), reason: error.code, observedAt: now(),
            retryAt: now() + (error.code === 'wallet_busy' ? 60000 : 15 * 60000)
          } }, current.revision);
        });
        deferred++; continue;
      }
      requireThat(['pending', 'delivered', 'closed', 'failed'].includes(outcome.state), 'invalid_delivery_state');
      requireThat(outcome.resultHash === digest(request.result), 'delivery_result_mismatch');
      if (outcome.state === 'delivered') requireThat(outcome.finalized === true &&
        /^0x[0-9a-f]{64}$/.test(outcome.transactionHash), 'delivery_not_finalized');
      await store.transaction(async tx => {
        const current = await tx.read('contract-requests', request.id);
        requireThat(digest(current.value.result) === outcome.resultHash, 'delivery_result_mismatch');
        const safe = { state: outcome.state, resultHash: outcome.resultHash, observedAt: now() };
        if (outcome.state === 'pending') safe.retryAt = now() + 60000;
        if (['dispatch_subsidy_expired', 'dispatch_cancelled', 'dispatch_transaction_reverted'].includes(outcome.reason))
          safe.reason = outcome.reason;
        if (outcome.state === 'delivered') Object.assign(safe,
          { finalized: true, transactionHash: outcome.transactionHash });
        await tx.write('contract-requests', request.id, { ...current.value, delivery: safe }, current.revision);
      });
      delivered += outcome.state === 'delivered' ? 1 : 0;
    }
    await store.transaction(async tx => {
      await tx.write('contract-delivery-cursors', id, { after: rows.length === 100 ? rows.at(-1).id : '' }, scan?.revision ?? 0);
    });
    const prior = await store.read('contract-intake-cursors', id);
    let scanError = null;
    let batch = { events: [], cursor: prior?.value ?? { afterBlock: startBlock - 1, blockHash: null } };
    if (active) {
      try {
        const bindings = [];
        let after = '';
        for (;;) {
          const page = await store.list('contract-bindings', { after, limit: 1000 });
          for (const { value } of page) if (!value.revokedAt && value.expiresAt > now() && value.used < value.maxRequests &&
            value.chainId === profile.chainId && value.inbox?.toLowerCase() === profile.inbox.toLowerCase() && value.codeHash === profile.codeHash)
            bindings.push({ id: value.id, requester: value.requester });
          requireThat(bindings.length <= 4096, 'intake_binding_capacity');
          if (page.length < 1000) break;
          after = page.at(-1).id;
        }
        batch = await chain.scan({ ...batch.cursor, bindings });
      }
      catch (error) { scanError = error.code ?? 'intake_scan_unavailable'; }
    }
    let ingested = 0;
    for (const event of batch.events) {
      const binding = await store.read('contract-bindings', event.bindingId);
      if (!binding) continue; // Unadmitted public contract traffic incurs no work.
      // Binding words are public. A caller can reuse one from an older inbox;
      // it must not stall this generation's cursor or any other project's work.
      if (binding.value.chainId !== profile.chainId ||
        binding.value.inbox?.toLowerCase() !== profile.inbox.toLowerCase() ||
        binding.value.codeHash !== profile.codeHash) continue;
      try {
        await intake.ingest(event.bindingId, { transactionHash: event.transactionHash, logIndex: event.logIndex });
        ingested++;
      } catch (error) {
        if (!['contract_intake_disabled', 'contract_binding_inactive', 'contract_binding_exhausted', 'contract_request_closed', 'contract_request_in_progress',
          'scope_denied', 'unauthenticated', 'invalid_contract_input', 'contract_request_mismatch', 'invalid_input',
          'inbox_request_closed', 'unknown_field', 'invalid_shape', 'invalid_identifier',
          'chain_public_not_enabled', 'chain_admission_changed', 'chain_scope_not_reviewed'].includes(error.code)) {
          scanError = error.code ?? 'intake_observation_unavailable'; break;
        }
        await store.transaction(async tx => {
          // Keep the most recent rejection per admitted binding; public log
          // spam cannot create an unbounded private rejection history.
          const key = digest({ inbox: profile.inbox, bindingId: event.bindingId });
          const prior = await tx.read('contract-intake-rejections', key);
          await tx.write('contract-intake-rejections', key,
            { bindingId: event.bindingId, code: error.code, transactionHash: event.transactionHash,
              logIndex: event.logIndex, observedAt: now() }, prior?.revision ?? 0);
        });
      }
    }
    // Save only after the entire batch was accepted or deterministically denied.
    // A crash or concurrent cursor conflict causes harmless event replay.
    if (active && !scanError) await store.transaction(async tx => {
      await tx.write('contract-intake-cursors', id, batch.cursor, prior?.revision ?? 0);
    });
    const proposal = active ? await intake.run() : { state: 'disabled' };
    return { state: active ? 'active' : 'disabled', disabledReason, scanError, ingested, delivered, deferred,
      proposal: proposal.state ?? 'idle', afterBlock: batch.cursor.afterBlock };
  } };
}
