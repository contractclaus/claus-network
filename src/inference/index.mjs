import { amount, contentHash, copy, digest, integer, requireThat, shape, text } from '../shared/index.mjs';
import { reserve, settleReservation } from '../billing/index.mjs';

// Prepared domain module. Production has no enabled provider or worker.
// Profiles and allowances are operator-owned records, not model output.
export function validateInferenceProfile(p) {
  shape(p, ['id', 'version', 'enabled', 'providerId', 'accountId', 'model', 'providers',
    'asset', 'fundingAccount', 'permissionHash', 'dataPolicyHash', 'expiresAt',
    'maximumPerRequest', 'maxInputBytes', 'maxOutputTokens']);
  for (const key of ['id', 'version', 'providerId', 'accountId', 'model', 'asset', 'fundingAccount']) text(p[key]);
  requireThat(typeof p.enabled === 'boolean', 'invalid_inference_profile');
  contentHash(p.permissionHash); contentHash(p.dataPolicyHash);
  integer(p.expiresAt, 1); integer(p.maxInputBytes, 1, 65536); integer(p.maxOutputTokens, 1, 16384);
  requireThat(amount(p.maximumPerRequest) > 0n, 'invalid_inference_profile');
  requireThat(Array.isArray(p.providers) && p.providers.length > 0 && p.providers.length <= 32 &&
    new Set(p.providers).size === p.providers.length, 'invalid_inference_profile');
  p.providers.forEach(provider => text(provider));
  return copy(p);
}

const allowanceId = (projectId, profileId) => digest({ projectId, profileId });
const requestId = (projectId, idempotencyKey) => digest({ projectId, inference: idempotencyKey });
function requestBody(body) {
  shape(body, ['profileId', 'profileHash', 'model', 'input', 'maxOutputTokens', 'idempotencyKey']);
  text(body.profileId); text(body.model); text(body.idempotencyKey);
  contentHash(body.profileHash);
  integer(body.maxOutputTokens, 1, 16384);
  requireThat(typeof body.input === 'string' && body.input.trim() &&
    Buffer.byteLength(body.input) <= 65536, 'invalid_inference_input');
  const { idempotencyKey, ...request } = body;
  return copy(request);
}

export function createInference({ store, identity, jobs, artifacts, provider,
  verifyQuote = async () => false, verifyReceipt = async () => false,
  enabled = () => false, now = () => Date.now() }) {
  async function owned(reader, projectId, id) {
    const row = await reader.read('inference-requests', text(id));
    requireThat(row?.value.projectId === projectId, 'not_found'); return row;
  }
  function visible(row) {
    const v = row.value;
    return { id: v.id, projectId: v.projectId, model: v.profile.model, profileHash: v.profileHash,
      requestHash: v.requestHash, jobId: v.jobId, work: v.work, outputHash: v.outputHash,
      cost: { asset: v.profile.asset, maximum: v.quote.maximum, actual: v.actual,
        state: v.billing }, providerRequestId: v.providerRequestId, revision: row.revision };
  }
  async function maySubmit(reader, actor, projectId, profileId) {
    requireThat(await enabled(reader) === true, 'inference_disabled');
    await identity.authorize(actor, 'inference.submit', { projectId }, reader);
    const profile = validateInferenceProfile((await reader.read('inference-profiles', profileId))?.value);
    requireThat(profile.id === profileId && profile.enabled && profile.expiresAt > now(), 'inference_profile_unavailable');
    const grant = await reader.read('inference-allowances', allowanceId(projectId, profileId));
    requireThat(grant?.value.enabled === true && grant.value.expiresAt > now(), 'inference_allowance_unavailable');
    for (const key of ['limit', 'reserved', 'spent']) amount(grant.value[key]);
    return { profile, grant };
  }
  async function adjustGrant(tx, v, reservedDelta, spentDelta) {
    const key = allowanceId(v.projectId, v.profile.id), old = await tx.read('inference-allowances', key);
    requireThat(old, 'inference_allowance_missing');
    const reserved = amount(old.value.reserved) + reservedDelta, spent = amount(old.value.spent) + spentDelta;
    requireThat(reserved >= 0n && spent >= 0n, 'invalid_reservation');
    await tx.write('inference-allowances', key, { ...old.value, reserved: reserved.toString(), spent: spent.toString() }, old.revision);
  }
  async function releaseUnsent(tx, v) {
    const old = await owned(tx, v.projectId, v.id);
    const job = await tx.read('workflow-jobs', v.jobId);
    requireThat(job?.value.effect === 'not_started' && old.value.billing === 'reserved' &&
      old.value.work === 'queued', 'inference_already_started');
    await settleReservation(tx, v.profile.fundingAccount, v.profile.asset, v.quote.maximum, '0');
    await adjustGrant(tx, v, -amount(v.quote.maximum), 0n);
    await tx.write('inference-requests', v.id, { ...old.value, work: 'cancelled', billing: 'void', actual: '0' }, old.revision);
  }
  function quoteMatches(q, profile, hash) {
    shape(q, ['id', 'providerId', 'accountId', 'asset', 'requestHash', 'profileHash', 'maximum', 'expiresAt', 'proofHash']);
    text(q.id); contentHash(q.proofHash); integer(q.expiresAt, 1);
    requireThat(q.providerId === profile.providerId && q.accountId === profile.accountId &&
      q.asset === profile.asset && q.requestHash === hash && q.profileHash === digest(profile) &&
      amount(q.maximum) > 0n && amount(q.maximum) <= amount(profile.maximumPerRequest) &&
      q.expiresAt > now() && q.expiresAt <= profile.expiresAt, 'inference_quote_mismatch');
  }
  async function networkOwner(reader, actor) {
    const credential = await identity.credential(actor, reader);
    const principal = (await reader.read('principals', credential.principalId))?.value;
    const authority = (await reader.read('network', 'authority'))?.value;
    requireThat(credential.kind === 'owner' && principal?.chainId === 1 &&
      typeof principal?.address === 'string' && principal.address === authority?.ownerAddress, 'scope_denied');
  }
  const api = {
    async setProfile(actor, { profile, expectedRevision }) {
      const value = validateInferenceProfile(profile); integer(expectedRevision);
      requireThat(value.expiresAt > now() && value.expiresAt <= now() + 30 * 86400000, 'invalid_profile_expiry');
      return store.transaction(async tx => {
        await networkOwner(tx, actor);
        const old = await tx.read('inference-profiles', value.id);
        if (old) {
          const { enabled: beforeEnabled, ...before } = old.value;
          const { enabled: afterEnabled, ...after } = value;
          requireThat(digest(before) === digest(after), 'inference_profile_immutable');
        }
        const saved = await tx.write('inference-profiles', value.id, value, expectedRevision);
        await tx.event({ type: 'inference.profile_configured', profileId: value.id,
          profileHash: digest(value), enabled: value.enabled, at: now() });
        return { profileId: value.id, profileHash: digest(value), revision: saved.revision };
      });
    },
    async setAllowance(actor, projectId, { profileId, enabled: active, expiresAt, limit, expectedRevision }) {
      text(projectId); text(profileId); integer(expiresAt, now() + 1); integer(expectedRevision); amount(limit);
      requireThat(typeof active === 'boolean', 'invalid_inference_allowance');
      return store.transaction(async tx => {
        await networkOwner(tx, actor);
        requireThat(await tx.read('projects', projectId), 'not_found');
        const profile = validateInferenceProfile((await tx.read('inference-profiles', profileId))?.value);
        requireThat(expiresAt <= profile.expiresAt, 'invalid_profile_expiry');
        const key = allowanceId(projectId, profileId), old = await tx.read('inference-allowances', key);
        const reserved = old?.value.reserved ?? '0', spent = old?.value.spent ?? '0';
        requireThat(amount(limit) >= amount(reserved) + amount(spent), 'inference_allowance_below_exposure');
        const value = { enabled: active, expiresAt, limit, reserved, spent };
        const saved = await tx.write('inference-allowances', key, value, expectedRevision);
        await tx.event({ type: 'inference.allowance_configured', projectId, profileId, limit, enabled: active, at: now() });
        return { projectId, profileId, ...value, revision: saved.revision };
      });
    },
    async profile(actor, projectId, profileId) {
      await identity.authorize(actor, 'inference.read', { projectId });
      const grant = await store.read('inference-allowances', allowanceId(projectId, profileId));
      requireThat(grant, 'not_found');
      const p = validateInferenceProfile((await store.read('inference-profiles', profileId))?.value);
      return { profileId, profileHash: digest(p), model: p.model, providers: p.providers,
        asset: p.asset, maximumPerRequest: p.maximumPerRequest, maxInputBytes: p.maxInputBytes,
        maxOutputTokens: p.maxOutputTokens, dataPolicyHash: p.dataPolicyHash, expiresAt: p.expiresAt,
        enabled: await enabled(store) === true && p.enabled && p.expiresAt > now() && grant.value.enabled && grant.value.expiresAt > now(),
        allowance: { ...grant.value, revision: grant.revision } };
    },
    async submit(actor, projectId, body) {
      text(projectId); const request = requestBody(body), hash = digest(request), id = requestId(projectId, body.idempotencyKey);
      await identity.authorize(actor, 'inference.submit', { projectId });
      const prior = await store.read('inference-requests', id);
      if (prior) { requireThat(prior.value.requestHash === hash, 'idempotency_conflict'); return visible(prior); }
      const { profile } = await maySubmit(store, actor, projectId, request.profileId);
      requireThat(request.profileHash === digest(profile), 'inference_profile_changed');
      requireThat(request.model === profile.model && request.maxOutputTokens <= profile.maxOutputTokens &&
        Buffer.byteLength(request.input) <= profile.maxInputBytes, 'inference_request_outside_profile');
      // Quote must be read-only. The independently supplied verifier establishes
      // that the selected adapter can enforce this exact financial ceiling.
      const quote = copy(await provider.quote({ request: copy(request), profile: copy(profile), requestHash: hash }));
      quoteMatches(quote, profile, hash);
      requireThat(await verifyQuote(copy(quote), copy(profile)) === true, 'inference_quote_unverified');
      return store.transaction(async tx => {
        const active = await maySubmit(tx, actor, projectId, request.profileId);
        const old = await tx.read('inference-requests', id);
        if (old) { requireThat(old.value.requestHash === hash, 'idempotency_conflict'); return visible(old); }
        requireThat(digest(active.profile) === quote.profileHash, 'inference_profile_changed');
        quoteMatches(quote, active.profile, hash);
        const g = active.grant.value;
        requireThat(amount(g.reserved) + amount(g.spent) + amount(quote.maximum) <= amount(g.limit), 'inference_allowance_exhausted');
        await reserve(tx, profile.fundingAccount, profile.asset, quote.maximum);
        const inputHash = await artifacts.put(tx, projectId, request);
        const job = await jobs.enqueue(tx, { projectId, kind: 'inference-execute', payload: { requestId: id },
          authority: { actor }, idempotencyKey: id });
        const value = { id, projectId, requestHash: hash, inputHash, profile, profileHash: quote.profileHash,
          quote, jobId: job.id, work: 'queued', billing: 'reserved', actual: null,
          providerRequestId: null, outputHash: null, receiptHash: null, createdAt: now() };
        await adjustGrant(tx, value, amount(quote.maximum), 0n);
        const saved = await tx.write('inference-requests', id, value, 0);
        await tx.event({ type: 'inference.reserved', projectId, requestId: id, at: now() });
        return visible(saved);
      });
    },
    async get(actor, projectId, id) {
      await identity.authorize(actor, 'inference.read', { projectId }); return visible(await owned(store, projectId, id));
    },
    async output(actor, projectId, id) {
      await identity.authorize(actor, 'inference.read', { projectId });
      const v = (await owned(store, projectId, id)).value;
      requireThat(v.outputHash, 'inference_output_unavailable'); return artifacts.get(projectId, v.outputHash);
    },
    async cancel(actor, projectId, id) {
      await identity.authorize(actor, 'inference.submit', { projectId });
      const row = await owned(store, projectId, id);
      await jobs.cancel(actor, projectId, row.value.jobId);
      return visible(await owned(store, projectId, id));
    },
    async onCancel(tx, job) {
      if (job.kind !== 'inference-execute') return;
      await releaseUnsent(tx, (await owned(tx, job.projectId, job.payload.requestId)).value);
    },
    async run() {
      requireThat(provider && typeof provider.dispatch === 'function' && typeof provider.reconcile === 'function', 'worker_not_configured');
      const claim = await jobs.claim({ kinds: ['inference-execute'], leaseMs: 300000 });
      if (claim.idle) return claim;
      let v = (await owned(store, claim.job.projectId, claim.job.payload.requestId)).value;
      if (claim.mode === 'dispatch') {
        try {
          await jobs.beginEffect(claim, async (_job, tx) => {
            const { profile, grant } = await maySubmit(tx, claim.job.authority.actor, v.projectId, v.profile.id);
            requireThat(digest(profile) === v.profileHash, 'inference_profile_changed');
            requireThat(amount(grant.value.reserved) + amount(grant.value.spent) <= amount(grant.value.limit), 'inference_allowance_exhausted');
            quoteMatches(v.quote, profile, v.requestHash);
            const old = await owned(tx, v.projectId, v.id);
            await tx.write('inference-requests', v.id, { ...old.value, work: 'outcome_unknown', billing: 'pending' }, old.revision);
            return true;
          });
        } catch (error) {
          if (error.code === 'lease_lost') return { stale: true };
          const current = await jobs.assertCurrent(claim);
          if (current.effect !== 'not_started') {
            return jobs.finish(claim, { state: 'waiting', retryAt: now() + 60000,
              result: { requestId: v.id, error: 'inference_dispatch_uncertain' } });
          }
          // This transaction did not begin an external effect. Only this path,
          // or an unsent job cancellation, may release without a cost receipt.
          return jobs.finish(claim, { state: 'blocked', result: { error: error.code ?? 'inference_not_authorized' } },
            tx => releaseUnsent(tx, v));
        }
      }
      let observation;
      try {
        const request = await artifacts.get(v.projectId, v.inputHash);
        const port = claim.mode === 'dispatch' ? provider.dispatch : provider.reconcile;
        observation = await port.call(provider, { effectKey: claim.job.effectKey, requestId: v.id,
          request: copy(request), requestHash: v.requestHash, profile: copy(v.profile), quote: copy(v.quote),
          providerRequestId: v.providerRequestId });
      } catch { observation = null; }
      try {
        const result = observation ?? {};
        const providerId = result.providerRequestId ?? v.providerRequestId;
        if (providerId !== null) text(providerId);
        requireThat(!v.providerRequestId || providerId === v.providerRequestId, 'inference_provider_identity_changed');
        let output = null;
        if (result.output) {
          shape(result.output, ['model', 'text']);
          requireThat(result.output.model === v.profile.model && typeof result.output.text === 'string' &&
            Buffer.byteLength(result.output.text) <= 262144, 'invalid_inference_output');
          output = copy(result.output);
        }
        let receipt = null;
        if (result.receipt) {
          receipt = copy(result.receipt);
          shape(receipt, ['effectKey', 'requestHash', 'profileHash', 'quoteId', 'providerId', 'accountId',
            'providerRequestId', 'asset', 'actual', 'final', 'proofHash']);
          contentHash(receipt.proofHash);
          requireThat(receipt.effectKey === claim.job.effectKey && receipt.requestHash === v.requestHash &&
            receipt.profileHash === v.profileHash && receipt.quoteId === v.quote.id &&
            receipt.providerId === v.profile.providerId && receipt.accountId === v.profile.accountId &&
            receipt.providerRequestId === providerId && providerId !== null &&
            receipt.asset === v.profile.asset && receipt.final === true &&
            amount(receipt.actual) <= amount(v.quote.maximum), 'inference_receipt_mismatch');
          requireThat(await verifyReceipt(copy(receipt), copy(v)) === true, 'inference_receipt_unverified');
        }
        requireThat(['completed', 'failed', 'unknown', undefined].includes(result.work), 'invalid_inference_work');
        requireThat(result.work !== 'completed' || output || v.outputHash, 'inference_output_missing');
        const work = result.work === 'completed' || v.work === 'completed' ? 'completed' :
          result.work === 'failed' || v.work === 'failed' ? 'failed' : 'outcome_unknown';
        const billingFinal = receipt !== null || v.billing === 'settled';
        const terminal = billingFinal && ['completed', 'failed'].includes(work);
        return await jobs.finish(claim, { state: terminal ? 'complete' : 'waiting',
          retryAt: terminal ? null : now() + 60000, result: { requestId: v.id, work, billing: billingFinal ? 'settled' : 'pending' } }, async tx => {
          const old = await owned(tx, v.projectId, v.id), next = { ...old.value, work, providerRequestId: providerId };
          if (providerId !== null) {
            const key = digest({ providerId: v.profile.providerId, accountId: v.profile.accountId, providerRequestId: providerId });
            const used = await tx.read('inference-provider-requests', key);
            requireThat(!used || used.value.requestId === v.id, 'inference_receipt_already_used');
            if (!used) await tx.write('inference-provider-requests', key, { requestId: v.id }, 0);
          }
          if (output) {
            const outputHash = await artifacts.put(tx, v.projectId, output);
            requireThat(!next.outputHash || next.outputHash === outputHash, 'inference_output_changed');
            next.outputHash = outputHash;
          }
          if (receipt) {
            const hash = digest(receipt);
            requireThat(!next.receiptHash || next.receiptHash === hash, 'inference_receipt_changed');
            if (!next.receiptHash) {
              await settleReservation(tx, v.profile.fundingAccount, v.profile.asset, v.quote.maximum, receipt.actual);
              await adjustGrant(tx, v, -amount(v.quote.maximum), amount(receipt.actual));
              next.receiptHash = await artifacts.put(tx, v.projectId, receipt);
              next.actual = receipt.actual; next.billing = 'settled';
            }
          }
          await tx.write('inference-requests', v.id, next, old.revision);
          await tx.event({ type: 'inference.observed', projectId: v.projectId, requestId: v.id,
            work, billing: next.billing, at: now() });
        });
      } catch (error) {
        if (error.code === 'lease_lost') return { stale: true };
        // A malformed observation cannot forgive a possibly paid request.
        return jobs.finish(claim, { state: 'waiting', retryAt: now() + 60000,
          result: { requestId: v.id, error: 'inference_observation_unverified' } });
      }
    }
  };
  return api;
}
