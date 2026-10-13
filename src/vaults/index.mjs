import { digest, requireThat } from '../shared/index.mjs';

// One immutable vault per project. Its existing registered, reviewed policy
// controls admission only. Deployment never grants authority over principal.
export function createVaults({ store, identity, jobs, chain, now = () => Date.now() }) {
  async function allowed(actor, projectId, reader = store) {
    await identity.authorize(actor, 'vault.manage', { projectId }, reader);
    const cap = (await reader.read('network-capabilities', 'vaults'))?.value;
    const pilot = (await reader.read('review-pilots', projectId))?.value;
    requireThat(cap?.enabled === true && cap.chainId === 11155111 && cap.reviewArtifactHash, 'vaults_not_enabled');
    requireThat(pilot?.enabled === true && pilot.expiresAt > now(), 'sponsor_not_enabled');
    return cap;
  }
  async function binding(reader, projectId, cap) {
    const value = (await reader.read('chain-bindings', projectId))?.value;
    const admission = cap.policies?.[projectId];
    requireThat(value?.chainId === 11155111 && value.profile === 'claus-readonly-v1' &&
      value.verification?.state === 'verified', 'policy_not_verified');
    requireThat(admission?.bindingHash === digest(value) && admission.configurationBytes === 64 &&
      /^0x[0-9a-fA-F]{40}$/.test(admission.implementation) && /^0x[0-9a-fA-F]{64}$/.test(admission.implementationCodeHash),
      'policy_not_verified');
    return { policy: value, admission };
  }
  async function current(reader, projectId) {
    const value = (await reader.read('project-vaults', projectId))?.value;
    requireThat(value, 'not_found'); return value;
  }
  const api = {
    async get(actor, projectId) {
      await identity.authorize(actor, 'vault.read', { projectId });
      return (await store.read('project-vaults', projectId))?.value ?? null;
    },
    async create(actor, projectId) {
      return store.transaction(async tx => {
        const cap = await allowed(actor, projectId, tx);
        const { policy, admission } = await binding(tx, projectId, cap);
        const old = await tx.read('project-vaults', projectId);
        if (old && !['cancelled', 'blocked', 'failed'].includes(old.value.state)) return old.value;
        requireThat(!await tx.read('project-signals',projectId),'signal_review_context_changed');
        const consumer=await tx.read('project-consumer-claims',projectId);
        requireThat(!consumer||consumer.value.profile==='claus-native-principal-v1','signal_review_context_changed');
        if(!consumer)await tx.write('project-consumer-claims',projectId,{profile:'claus-native-principal-v1'},0);
        // Terminal pre-broadcast failures can retry; uncertain transactions
        // never become a new deployment attempt.
        const attempt = (old?.value.attempt ?? 0) + 1;
        requireThat(attempt <= 4, 'capacity_reached');
        const id = digest({ kind: 'vault-deploy', projectId, attempt });
        const job = await jobs.enqueue(tx, { projectId, kind: 'vault-deploy',
          authority: { actor }, payload: { vaultId: id }, idempotencyKey: id });
        const value = { id, projectId, attempt, profile: 'claus-native-principal-v1', chainId: 11155111,
          policy, admission, artifactProjectId: cap.artifactProjectId, artifactHash: cap.artifactHash,
          reviewArtifactHash: cap.reviewArtifactHash, jobId: job.id, state: 'queued',
          expiresAt: now() + 86400000, createdAt: now() };
        await tx.write('project-vaults', projectId, value, old?.revision ?? 0);
        return value;
      });
    },
    async transaction(actor, projectId, input) {
      await identity.authorize(actor, 'vault.read', { projectId });
      const vault = await current(store, projectId);
      requireThat(vault.state === 'verified', 'vault_not_verified');
      // Reading an exit transaction remains possible after sponsor withdrawal
      // or disabling new vault deployment. The caller signs and sends it.
      return chain.transaction(vault, input);
    },
    async balance(actor, projectId, account) {
      await identity.authorize(actor, 'vault.read', { projectId });
      const vault = await current(store, projectId);
      requireThat(vault.state === 'verified', 'vault_not_verified');
      return chain.balance(vault, account);
    },
    async onCancel(tx, job) {
      if (job.kind !== 'vault-deploy') return;
      const old = await tx.read('project-vaults', job.projectId);
      requireThat(old?.value.id === job.payload.vaultId, 'vault_action_changed');
      await tx.write('project-vaults', job.projectId, { ...old.value, state: 'cancelled' }, old.revision);
    },
    async runOne(executor) {
      const claim = await jobs.claim({ kinds: ['vault-deploy'], leaseMs: 120000 });
      if (claim.idle) return claim;
      const value = await current(store, claim.job.projectId);
      requireThat(value.id === claim.job.payload.vaultId, 'vault_action_changed');
      const authorize = async reader => {
        await jobs.assertCurrent(claim, reader);
        const cap = await allowed(claim.job.authority.actor, value.projectId, reader);
        requireThat(cap.artifactHash === value.artifactHash && cap.artifactProjectId === value.artifactProjectId &&
          cap.reviewArtifactHash === value.reviewArtifactHash, 'vault_profile_changed');
        requireThat(digest(await binding(reader, value.projectId, cap)) ===
          digest({ policy: value.policy, admission: value.admission }), 'project_binding_changed');
        return true;
      };
      async function finish(result) {
        const done = result.state === 'verified', stopped = ['blocked', 'failed'].includes(result.state);
        return jobs.finish(claim, { state: done ? 'complete' : stopped ? result.state : 'waiting',
          retryAt: done || stopped ? null : now() + 30000, result }, async tx => {
          const old = await tx.read('project-vaults', value.projectId);
          requireThat(old.value.id === value.id, 'vault_action_changed');
          await tx.write('project-vaults', value.projectId, { ...old.value, ...result, updatedAt: now() }, old.revision);
        });
      }
      try {
        if (claim.mode === 'dispatch') await jobs.beginEffect(claim, (_job, tx) => authorize(tx));
        return await finish(await executor.step({ value, authorize }));
      } catch (error) {
        if (error.code === 'lease_lost') return { stale: true };
        const blocked = claim.mode === 'dispatch' && ['scope_denied', 'sponsor_not_enabled', 'vaults_not_enabled',
          'vault_profile_changed', 'policy_not_verified', 'project_binding_changed'].includes(error.code);
        return finish({ state: blocked ? 'blocked' : 'waiting', error: error.code ?? 'vault_execution_unavailable' });
      }
    }
  };
  return api;
}
