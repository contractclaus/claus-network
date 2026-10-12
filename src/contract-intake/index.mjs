import { canonical, contentHash, copy, digest, integer, requireThat, shape, text } from '../shared/index.mjs';

const address = value => {
  requireThat(typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/.test(value), 'invalid_address');
  return value.toLowerCase();
};
const word = value => {
  requireThat(typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value), 'invalid_word');
  return value;
};
export const bindingWord = id => '0x' + id.slice('sha256:'.length);
export const proposalKey = id => 'contract-intake:' + id;
export const intakeProposalId = (projectId, id) => digest({ projectId, idempotencyKey: proposalKey(id), kind: 'protected-upgrade' });

// All chain observations and proposal ports are supplied by the trusted host.
// Public callers cannot submit a claimed event, choose a dispatcher, or invoke
// the worker. This first profile only requests an already-reviewed module's
// configuration change; it does not grant deployment or payment authority.
export function createContractIntake({ store, identity, jobs, chain, createProposal, readProposal,
  enabled = () => false, now = () => Date.now() }) {
  const bindingView = row => {
    const { actor, ...value } = row.value;
    return { ...value, revision: row.revision, onchainBinding: bindingWord(value.id) };
  };
  async function owned(reader, collection, projectId, id) {
    const row = await reader.read(collection, text(id));
    requireThat(row?.value.projectId === projectId, 'not_found'); return row;
  }
  async function admitted(reader, binding) {
    requireThat(await enabled(reader, binding.projectId) === true, 'contract_intake_disabled');
    requireThat(!binding.revokedAt && binding.expiresAt > now(), 'contract_binding_inactive');
    await identity.authorize(binding.actor, 'contract.request', { projectId: binding.projectId }, reader);
    await identity.authorize(binding.actor, 'proposal.create', { projectId: binding.projectId }, reader);
  }
  const api = {
    async bind(actor, projectId, body) {
      shape(body, ['requester', 'expiresAt', 'maxRequests', 'idempotencyKey']);
      const requester = address(body.requester);
      integer(body.expiresAt, now() + 1000, now() + 30 * 86400000);
      integer(body.maxRequests, 1, 100); text(body.idempotencyKey);
      const chainProfile = await chain.profile();
      requireThat(chainProfile.chainId === 11155111, 'unsupported_chain');
      address(chainProfile.inbox); word(chainProfile.codeHash);
      const config = { projectId, actor, requester, expiresAt: body.expiresAt, maxRequests: body.maxRequests,
        chainId: chainProfile.chainId, inbox: address(chainProfile.inbox), codeHash: chainProfile.codeHash,
        capability: word(chainProfile.capability) };
      const id = digest({ projectId, contractBinding: body.idempotencyKey });
      return store.transaction(async tx => {
        await admitted(tx, config);
        const old = await tx.read('contract-bindings', id);
        if (old) { requireThat(old.value.configHash === digest(config), 'idempotency_conflict'); return bindingView(old); }
        const row = await tx.write('contract-bindings', id, { ...config, id, configHash: digest(config), used: 0,
          revokedAt: null, createdAt: now() }, 0);
        await tx.event({ type: 'contract.binding_created', projectId, bindingId: id, at: now() });
        return bindingView(row);
      });
    },
    async binding(actor, projectId, id) {
      await identity.authorize(actor, 'contract.read', { projectId });
      return bindingView(await owned(store, 'contract-bindings', projectId, id));
    },
    async revoke(actor, projectId, id) {
      return store.transaction(async tx => {
        await identity.authorize(actor, 'contract.revoke', { projectId }, tx);
        const row = await owned(tx, 'contract-bindings', projectId, id);
        if (row.value.revokedAt) return bindingView(row);
        const next = await tx.write('contract-bindings', id, { ...row.value, revokedAt: now() }, row.revision);
        await tx.event({ type: 'contract.binding_revoked', projectId, bindingId: id, at: now() });
        return bindingView(next);
      });
    },
    async request(actor, projectId, id) {
      await identity.authorize(actor, 'contract.read', { projectId });
      const { observation, ...value } = (await owned(store, 'contract-requests', projectId, id)).value;
      return copy(value);
    },
    async ingest(bindingId, pointer) {
      const binding = (await store.read('contract-bindings', text(bindingId)))?.value;
      requireThat(binding, 'not_found');
      // The host verifies canonical receipt, log, runtime and finalized height.
      const observation = await chain.observe(binding, pointer);
      requireThat(observation.finalized === true && observation.state === 'pending' &&
        observation.chainId === binding.chainId && address(observation.inbox) === binding.inbox &&
        observation.codeHash === binding.codeHash && word(observation.binding) === bindingWord(bindingId) &&
        address(observation.requester) === binding.requester && observation.capability === binding.capability,
      'contract_request_mismatch');
      word(observation.requestId); word(observation.blockHash);
      integer(observation.blockNumber, 0); integer(observation.deadline, 1);
      shape(observation.input, ['moduleId', 'configuration']);
      text(observation.input.moduleId);
      requireThat(typeof observation.input.configuration === 'string' &&
        /^0x(?:[0-9a-fA-F]{2})*$/.test(observation.input.configuration) &&
        Buffer.byteLength(canonical(observation.input)) <= 8192, 'invalid_contract_input');
      const id = digest({ chainId: binding.chainId, inbox: binding.inbox, requestId: observation.requestId });
      return store.transaction(async tx => {
        const old = await tx.read('contract-requests', id);
        if (old) {
          requireThat(old.value.observationHash === digest(observation), 'contract_event_changed');
          return { id, state: old.value.state };
        }
        requireThat(observation.deadline * 1000 > now(), 'contract_request_closed');
        const current = await owned(tx, 'contract-bindings', binding.projectId, bindingId);
        await admitted(tx, current.value);
        requireThat(current.value.used < current.value.maxRequests, 'contract_binding_exhausted');
        const job = await jobs.enqueue(tx, { projectId: binding.projectId, kind: 'contract-intake',
          payload: { requestId: id }, authority: { actor: binding.actor }, idempotencyKey: id });
        await tx.write('contract-bindings', bindingId, { ...current.value, used: current.value.used + 1 }, current.revision);
        await tx.write('contract-requests', id, { id, projectId: binding.projectId, bindingId, jobId: job.id,
          observation: copy(observation), observationHash: digest(observation), state: 'queued',
          proposalId: intakeProposalId(binding.projectId, id), result: null, createdAt: now() }, 0);
        await tx.event({ type: 'contract.request_received', projectId: binding.projectId, requestId: id, at: now() });
        return { id, state: 'queued' };
      });
    },
    async run() {
      const claim = await jobs.claim({ kinds: ['contract-intake'], leaseMs: 60000 });
      if (claim.idle) return claim;
      const request = (await owned(store, 'contract-requests', claim.job.projectId, claim.job.payload.requestId)).value;
      const binding = (await owned(store, 'contract-bindings', request.projectId, request.bindingId)).value;
      const update = (state, result, error) => async tx => {
        const row = await owned(tx, 'contract-requests', request.projectId, request.id);
        await tx.write('contract-requests', request.id, { ...row.value, state, result,
          ...(error ? { error } : {}), updatedAt: now() }, row.revision);
      };
      let proposal = await readProposal(request.projectId, request.proposalId);
      if (!proposal) {
        try {
          // Rechecking this read before creation also handles a crash after an
          // internal effect intent but before proposal creation. The downstream
          // idempotency key remains identical; there is no paid blind retry.
          const current = await chain.pending(binding, request.observation);
          requireThat(current === true && request.observation.deadline * 1000 > now(), 'contract_request_closed');
          if (claim.mode === 'dispatch') await jobs.beginEffect(claim, async (_job, tx) => {
            await admitted(tx, (await owned(tx, 'contract-bindings', request.projectId, request.bindingId)).value);
            return true;
          });
          else await admitted(store, (await owned(store, 'contract-bindings', request.projectId, request.bindingId)).value);
          proposal = await createProposal(binding.actor, request.projectId,
            { ...request.observation.input, idempotencyKey: proposalKey(request.id) });
        } catch (error) {
          if (error.code === 'lease_lost') return { stale: true };
          // A transport failure might have created the proposal. Keep the
          // original request; the next run looks it up before any admission.
          const denied = ['contract_intake_disabled', 'contract_binding_inactive', 'scope_denied', 'unauthenticated',
            'contract_request_closed'].includes(error.code);
          return jobs.finish(claim, { state: denied ? 'blocked' : 'waiting',
            ...(denied ? {} : { retryAt: now() + 60000 }), result: { requestId: request.id, error: denied ? error.code : 'proposal_pending' } },
          update(denied ? 'blocked' : 'waiting', null, denied ? error.code : undefined));
        }
      }
      requireThat(proposal.id === request.proposalId && proposal.projectId === request.projectId &&
        proposal.requestHash === digest(request.observation.input), 'contract_proposal_mismatch');
      // The request can stop waiting without cancelling or replacing its
      // independently tracked proposal. A failure is never a Claus decision.
      if (!proposal.decision) {
        const error = ['failed', 'blocked', 'cancelled'].includes(proposal.state) ? 'proposal_' + proposal.state :
          request.observation.deadline * 1000 <= now() ? 'contract_request_closed' : null;
        if (error) return jobs.finish(claim, { state: 'blocked', result: { requestId: request.id,
          proposalId: proposal.id, error } }, update('blocked', null, error));
      }
      if (!proposal.decision) return jobs.finish(claim, { state: 'waiting', retryAt: now() + 60000,
        result: { requestId: request.id, proposalId: proposal.id } }, update('waiting', null));
      requireThat(['approve', 'reject'].includes(proposal.decision.decision), 'invalid_contract_decision');
      // Only this small public receipt can be returned onchain. No private
      // review text, source, credential, signature or model prompt is included.
      const result = { kind: 'proposal-decision', proposalId: proposal.id,
        decision: proposal.decision.decision, decisionHash: proposal.decision.decisionHash };
      contentHash(result.decisionHash);
      return jobs.finish(claim, { state: 'complete', result: { requestId: request.id, proposalId: proposal.id } }, update('result_ready', result));
    },
    async onCancel(tx, job) {
      if (job.kind !== 'contract-intake') return;
      const row = await owned(tx, 'contract-requests', job.projectId, job.payload.requestId);
      await tx.write('contract-requests', row.value.id, { ...row.value, state: 'cancelled', updatedAt: now() }, row.revision);
    }
  };
  return api;
}
