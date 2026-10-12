import { digest, requireThat } from '../src/shared/index.mjs';

// Transport-neutral worker. Production must provide an admitted, budgeted
// dispatcher with durable same-ID transactions. Neither API credentials nor
// this worker contain a signing key. The separate hosted entry requires an
// explicit deployment pin, reviewed admission and bounded spending grant.
export function createContractIntakeWorker({ store, intake, chain, delivery, startBlock,
  enabled = async () => false, now = () => Date.now() }) {
  requireThat(Number.isSafeInteger(startBlock) && startBlock >= 1, 'invalid_start_block');
  return { async tick() {
    const active = await enabled() === true;
    const profile = await chain.profile();
    const id = digest({ chainId: profile.chainId, inbox: profile.inbox, codeHash: profile.codeHash });
    const prior = await store.read('contract-intake-cursors', id);
    const batch = active ? await chain.scan(prior?.value ?? { afterBlock: startBlock - 1, blockHash: null }) :
      { events: [], cursor: prior?.value ?? { afterBlock: startBlock - 1, blockHash: null } };
    let ingested = 0;
    for (const event of batch.events) {
      const binding = await store.read('contract-bindings', event.bindingId);
      if (!binding) continue; // Unadmitted public contract traffic incurs no work.
      try {
        await intake.ingest(event.bindingId, { transactionHash: event.transactionHash, logIndex: event.logIndex });
        ingested++;
      } catch (error) {
        if (!['contract_binding_inactive', 'contract_binding_exhausted', 'contract_request_closed',
          'scope_denied', 'invalid_contract_input', 'contract_request_mismatch', 'invalid_input',
          'inbox_request_closed', 'unknown_field', 'invalid_shape', 'invalid_identifier'].includes(error.code)) throw error;
        await store.transaction(async tx => {
          const key = digest({ inbox: profile.inbox, transactionHash: event.transactionHash, logIndex: event.logIndex });
          if (!await tx.read('contract-intake-rejections', key)) await tx.write('contract-intake-rejections', key,
            { bindingId: event.bindingId, code: error.code, observedAt: now() }, 0);
        });
      }
    }
    // Save only after the entire batch was accepted or deterministically denied.
    // A crash or concurrent cursor conflict causes harmless event replay.
    if (active) await store.transaction(async tx => {
      await tx.write('contract-intake-cursors', id, batch.cursor, prior?.revision ?? 0);
    });
    const proposal = active ? await intake.run() : { state: 'disabled' };
    const scan = await store.read('contract-delivery-cursors', id);
    const rows = await store.list('contract-requests', { after: scan?.value.after ?? '', limit: 100 });
    let delivered = 0;
    for (const row of rows) {
      const request = row.value;
      if (request.state !== 'result_ready' || ['delivered', 'closed', 'failed'].includes(request.delivery?.state)) continue;
      if (!delivery) continue;
      // The dispatcher independently verifies onchain state, immutable result,
      // expiry and its current spending mandate. It must reconcile old writes
      // even after that mandate is revoked; it must never replace unknown txs.
      const outcome = await delivery.step({ id: digest({ requestId: request.id, action: 'result-delivery' }), request,
        allowSubmit: active });
      requireThat(['pending', 'delivered', 'closed', 'failed'].includes(outcome.state), 'invalid_delivery_state');
      requireThat(outcome.resultHash === digest(request.result), 'delivery_result_mismatch');
      if (outcome.state === 'delivered') requireThat(outcome.finalized === true &&
        /^0x[0-9a-f]{64}$/.test(outcome.transactionHash), 'delivery_not_finalized');
      await store.transaction(async tx => {
        const current = await tx.read('contract-requests', request.id);
        requireThat(digest(current.value.result) === outcome.resultHash, 'delivery_result_mismatch');
        const safe = { state: outcome.state, resultHash: outcome.resultHash, observedAt: now() };
        if (outcome.state === 'delivered') Object.assign(safe,
          { finalized: true, transactionHash: outcome.transactionHash });
        await tx.write('contract-requests', request.id, { ...current.value, delivery: safe }, current.revision);
      });
      delivered += outcome.state === 'delivered' ? 1 : 0;
    }
    await store.transaction(async tx => {
      await tx.write('contract-delivery-cursors', id, { after: rows.length === 100 ? rows.at(-1).id : '' }, scan?.revision ?? 0);
    });
    return { state: active ? 'active' : 'disabled', ingested, delivered, proposal: proposal.state ?? 'idle', afterBlock: batch.cursor.afterBlock };
  } };
}
