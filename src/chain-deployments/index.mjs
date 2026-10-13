export { MANAGED_PROFILE, READONLY_PROFILE, chainProfile, projectProfile } from './profiles.mjs';
import { createChainAdmission } from './admission.mjs';
export { createChainAdmission } from './admission.mjs';
import { digest, requireThat, text } from '../shared/index.mjs';
import { chainProfile, projectProfile, READONLY_PROFILE, MANAGED_PROFILE } from './profiles.mjs';

export function createChainDeployments({ store, identity, builds, reviews, jobs, artifacts, chain, now = () => Date.now() }) {
  const admissions = new Map();
  function forChain(chainId = 11155111, profile = READONLY_PROFILE) {
    const selected = chainProfile(chainId, profile);
    if (!admissions.has(selected.capability)) admissions.set(selected.capability,
      createChainAdmission({ store, identity, now, chainId, profile }));
    return admissions.get(selected.capability);
  }
  const admission = { ...forChain(), forChain,
    get: (actor, input = {}) => forChain(input.chainId, input.profile).get(actor),
    publish: (actor, input) => forChain(input.chainId, input.profile).publish(actor, input),
    activate: (actor, input) => forChain(input.chainId, input.profile).activate(actor, input) };
  const selection = (reader, projectId, chainId, profile) => projectProfile(reader, projectId, { chainId, profile });
  const projectChain = async (reader, projectId, requested) => (await selection(reader, projectId, requested)).chainId;
  async function find(reader, collection, projectId, id) {
    const row = await reader.read(collection, text(id));
    requireThat(row?.value.projectId === projectId, 'not_found'); return row;
  }
  async function allowed(actor, projectId, reader = store, requestedChain, requestedProfile) {
    await identity.authorize(actor, 'proposal.execute', { projectId }, reader);
    const { chainId, profile, capability: capKey } = await selection(reader, projectId, requestedChain, requestedProfile);
    const pilot = (await reader.read('review-pilots', projectId))?.value;
    const capability = (await reader.read('network-capabilities', capKey))?.value;
    requireThat(capability?.enabled === true && capability.chainId === chainId && capability.profile === profile, 'chain_not_enabled');
    if (profile !== READONLY_PROFILE || chainId === 1 || !pilot?.enabled || pilot.expiresAt <= now() || await reader.read('public-chain-projects', projectId)) {
      const config = await forChain(chainId, profile).admitted(reader);
      const binding = (await reader.read('chain-bindings', projectId))?.value;
      requireThat(!binding || binding.executor?.toLowerCase() === config.executor.toLowerCase() && (binding.profile ?? READONLY_PROFILE) === profile, 'chain_admission_changed');
    }
    return capability;
  }
  const api = {
    allowed, admission, projectChain,
    async reviewProfile(reader, projectId, requested) {
      const selected = await selection(reader, projectId, requested.chainId, requested.profile);
      if (selected.profile === MANAGED_PROFILE) {
        await forChain(selected.chainId, selected.profile).admitted(reader);
      }
      return { chainId: selected.chainId, profile: selected.profile };
    },
    async onCancel(tx, job) {
      const moduleJob = job.kind === 'module-deploy';
      if (!moduleJob && job.kind !== 'project-register') return;
      const collection = moduleJob ? 'chain-modules' : 'chain-registrations';
      const id = job.payload[moduleJob ? 'moduleId' : 'registrationId'];
      const old = await find(tx, collection, job.projectId, id);
      await tx.write(collection, id, { ...old.value, state: 'cancelled', updatedAt: now() }, old.revision);
    },
    async module(actor, projectId, moduleId) {
      await identity.authorize(actor, 'proposal.read', { projectId });
      return (await find(store, 'chain-modules', projectId, moduleId)).value;
    },
    async deployModule(actor, projectId, { caseId, chainId: requestedChain, profile: requestedProfile }) {
      const reviewed = await reviews.get(actor, projectId, caseId);
      requireThat(reviewed.state === 'reviewed' && reviewed.artifactHash, 'review_not_complete');
      const build = await builds.get(actor, projectId, reviewed.buildId);
      requireThat(build.state === 'compiled' && build.artifactHash === reviewed.input.buildHash, 'build_mismatch');
      const artifact = await artifacts.get(projectId, build.artifactHash);
      return store.transaction(async tx => {
        const { chainId, profile } = await selection(tx, projectId, requestedChain, requestedProfile);
        await allowed(actor, projectId, tx, chainId, profile);
        chain.validateModule(artifact, profile);
        const id = digest({ projectId, caseId, kind: 'module-deploy', ...(chainId === 1 ? { chainId } : {}), ...(profile !== READONLY_PROFILE ? { profile } : {}) });
        const old = await tx.read('chain-modules', id); if (old) return old.value;
        const pilot = (await tx.read('review-pilots', projectId))?.value;
        if (profile !== READONLY_PROFILE || chainId === 1 || !pilot?.enabled || pilot.expiresAt <= now() || await tx.read('public-chain-projects', projectId)) await forChain(chainId, profile).reserveProject(tx, projectId);
        const bound = await tx.read('chain-project-profiles', projectId);
        if (!bound) await tx.write('chain-project-profiles', projectId, { chainId, profile }, 0);
        if (await tx.read('public-chain-projects', projectId))
          requireThat((await identity.credential(actor, tx)).kind === 'agent', 'durable_agent_required');
        const job = await jobs.enqueue(tx, { projectId, kind: 'module-deploy', payload: { moduleId: id },
          authority: { actor }, idempotencyKey: id });
        const value = { id, projectId, caseId, buildId: build.id, artifactHash: build.artifactHash,
          state: 'queued', jobId: job.id, chainId, profile, expiresAt: now() + 86400000, createdAt: now() };
        await tx.write('chain-modules', id, value, 0); return value;
      });
    },
    async prepareRegistration(actor, projectId, { moduleId, configuration, mandateId, minDelaySeconds }) {
      const capability = await allowed(actor, projectId);
      const credential = await identity.credential(actor);
      const project = await identity.project(actor, projectId);
      requireThat(credential.kind === 'owner' && credential.principalId === project.ownerId, 'scope_denied');
      const owner = (await store.read('principals', project.ownerId))?.value;
      const module = (await find(store, 'chain-modules', projectId, moduleId)).value;
      requireThat(module.state === 'verified' && module.chainId === capability.chainId && (module.profile ?? READONLY_PROFILE) === capability.profile, 'module_not_verified');
      const mandate = (await store.read('mandates', text(mandateId)))?.value;
      requireThat(mandate?.projectId === projectId && !mandate.revokedAt && mandate.expiresAt > now() &&
        mandate.scopes.includes('proposal.execute'), 'invalid_mandate');
      const prepared = await chain.registration({ projectId, owner: owner.address, module, configuration,
        mandateHash: '0x' + digest(mandate).slice(7), minDelaySeconds, capability, expiresAt: Math.floor(now() / 1000) + 3600 });
      const id = digest(prepared);
      return store.transaction(async tx => {
        await allowed(actor, projectId, tx);
        requireThat(!await tx.read('chain-bindings', projectId), 'project_already_registered');
        const old = await tx.read('chain-registrations', id);
        if (old) return old.value;
        const registrations = await tx.list('chain-registrations', { projectId, limit: 17 });
        const active = registrations.find(({ value }) =>
          ['queued', 'registering', 'verifying'].includes(value.state) ||
          value.state === 'awaiting_signature' && value.message.expiresAt * 1000 > now());
        if (active) {
          requireThat(active.value.moduleId === moduleId && active.value.mandateId === mandateId &&
            active.value.configuration === configuration && active.value.message.minDelaySeconds === minDelaySeconds,
            'registration_in_progress');
          return active.value;
        }
        requireThat(registrations.length < 16, 'registration_limit');
        const value = { id, projectId, moduleId, mandateId, ...prepared, state: 'awaiting_signature', createdAt: now() };
        await tx.write('chain-registrations', id, value, 0);
        return value;
      });
    },
    async submitRegistration(actor, projectId, { registrationId, signature }) {
      const row = await find(store, 'chain-registrations', projectId, registrationId);
      const prepared = row.value;
      requireThat(await chain.verifyRegistration(prepared, signature), 'invalid_signature');
      return store.transaction(async tx => {
        await allowed(actor, projectId, tx);
        const old = await find(tx, 'chain-registrations', projectId, registrationId);
        if (old.value.state !== 'awaiting_signature') return old.value;
        requireThat(!await tx.read('chain-bindings', projectId), 'project_already_registered');
        const registrations = await tx.list('chain-registrations', { projectId, limit: 17 });
        requireThat(!registrations.some(row => row.id !== registrationId &&
          ['queued', 'registering', 'verifying'].includes(row.value.state)), 'registration_in_progress');
        // Expired signatures can still identify an already mined relay.
        // The executor reconciles them without submitting a new transaction.
        if (await tx.read('public-chain-projects', projectId))
          requireThat((await identity.credential(actor, tx)).kind === 'agent', 'durable_agent_required');
        const job = await jobs.enqueue(tx, { projectId, kind: 'project-register', payload: { registrationId },
          authority: { actor }, idempotencyKey: registrationId });
        await tx.write('chain-registration-signatures', registrationId, { signature }, 0);
        const value = { ...old.value, state: 'queued', jobId: job.id };
        await tx.write('chain-registrations', registrationId, value, old.revision); return value;
      });
    },
    async registration(actor, projectId, registrationId) {
      await identity.authorize(actor, 'proposal.read', { projectId });
      return (await find(store, 'chain-registrations', projectId, registrationId)).value;
    },
    async binding(actor, projectId) {
      await identity.authorize(actor, 'proposal.read', { projectId });
      return (await store.read('chain-bindings', projectId))?.value ?? null;
    },
    async runOne(executor) {
      const claim = await jobs.claim({ kinds: ['module-deploy', 'project-register'], leaseMs: 120000 });
      if (claim.idle) return claim;
      const moduleJob = claim.job.kind === 'module-deploy';
      const collection = moduleJob ? 'chain-modules' : 'chain-registrations';
      const id = claim.job.payload[moduleJob ? 'moduleId' : 'registrationId'];
      const value = (await find(store, collection, claim.job.projectId, id)).value;
      const authorize = async reader => {
        await jobs.assertCurrent(claim, reader);
        await allowed(claim.job.authority.actor, value.projectId, reader);
        return true;
      };
      try {
        await executor.preflight?.(value);
        if (claim.mode === 'dispatch') await jobs.beginEffect(claim, (_job, tx) => authorize(tx));
        const result = await executor.step({ kind: claim.job.kind, value, authorize,
          artifact: moduleJob ? await artifacts.get(value.projectId, value.artifactHash) : null,
          signature: moduleJob ? null : (await store.read('chain-registration-signatures', id))?.value.signature });
        const done = result.state === 'verified';
        const blocked = result.state === 'blocked';
        const failed = result.state === 'failed';
        return await jobs.finish(claim, { state: done ? 'complete' : blocked ? 'blocked' : failed ? 'failed' : 'waiting',
          retryAt: done || blocked || failed ? null : now() + 30000, result }, async tx => {
          const old = await find(tx, collection, value.projectId, id);
          await tx.write(collection, id, { ...old.value, ...result, updatedAt: now() }, old.revision);
          if (done && !moduleJob) {
            const previous = await tx.read('chain-bindings', value.projectId);
            requireThat(!previous || previous.value.registrationId === id, 'project_already_registered');
            if (!previous) await tx.write('chain-bindings', value.projectId, { ...result.binding,
              projectId: value.projectId, registrationId: id, moduleId: value.moduleId }, 0);
          }
        });
      } catch (error) {
        if (error.code === 'lease_lost') return { stale: true };
        if (['registered_project_mismatch', 'registration_receipt_mismatch', 'recovery_block_changed', 'recovery_event_mismatch'].includes(error.code) ||
          claim.mode === 'dispatch' && ['scope_denied', 'sponsor_not_enabled', 'chain_not_enabled'].includes(error.code)) {
          return jobs.finish(claim, { state: 'blocked', result: { error: error.code } }, async tx => {
            const old = await find(tx, collection, value.projectId, id);
            await tx.write(collection, id, { ...old.value, state: 'blocked', error: error.code, updatedAt: now() }, old.revision);
          });
        }
        return jobs.finish(claim, { state: 'waiting', retryAt: now() + (['chain_gas_exhausted', 'transaction_cost_limit', 'capacity_reached'].includes(error.code) ? 15 * 60000 : 60000),
          result: { error: error.code ?? 'chain_execution_unavailable' } });
      }
    }
  };
  return api;
}
