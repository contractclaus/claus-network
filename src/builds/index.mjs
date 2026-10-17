import { digest, requireThat, text } from '../shared/index.mjs';

export function createBuilds({ store, identity, projects, jobs, artifacts, now = () => Date.now(),
  limit = async () => undefined, limits = { version: 'compile-admission-v1', projectPerDay: 16, globalPerDay: 256 } }) {
  async function find(reader, projectId, id) {
    const record = await reader.read('builds', text(id));
    requireThat(record?.value.projectId === projectId, 'not_found');
    return record;
  }
  async function visible(reader, record) {
    const job = (await reader.read('workflow-jobs', record.value.jobId ?? record.value.id))?.value;
    return job?.state === 'waiting' ? { ...record.value, nextCheckAt: job.availableAt } : job?.state === 'cancelled' ? { ...record.value, state: 'cancelled', completedAt: job.updatedAt } : record.value;
  }
  return {
    async submit(actor, projectId, { snapshotId, entry, contract, idempotencyKey, compilerProfile, sourceRoot }) {
      text(idempotencyKey);
      requireThat(compilerProfile === undefined || ['solidity-static-compile-v1', 'solidity-0.8.26-static-v1', 'solidity-managed-compile-v1'].includes(compilerProfile), 'unsupported_compiler_profile');
      requireThat(sourceRoot === undefined || (typeof sourceRoot === 'string' && sourceRoot.length <= 160 &&
        /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(sourceRoot) &&
        sourceRoot.split('/').every(part => part !== '.' && part !== '..')), 'invalid_source_root');
      requireThat(sourceRoot === undefined || (typeof entry === 'string' && entry.startsWith(sourceRoot + '/')), 'entry_outside_source_root');
      requireThat(typeof contract === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(contract), 'invalid_contract');
      const snapshot = await projects.snapshot(actor, projectId, snapshotId);
      requireThat(snapshot.files.some(file => file.path === entry && entry.endsWith('.sol')), 'entry_missing');
      return store.transaction(async tx => {
        await identity.authorize(actor, 'build.compile', { projectId }, tx);
        const id = digest({ projectId, kind: 'compile', idempotencyKey });
        // Keep the original default payload and idempotency hash byte-for-byte.
        const payload = { snapshotId, entry, contract,
          ...(compilerProfile && compilerProfile !== 'solidity-static-compile-v1' ? { compilerProfile } : {}),
          ...(sourceRoot === undefined ? {} : { sourceRoot }) }, requestHash = digest(payload);
        const old = await tx.read('builds', id);
        if (old) { requireThat(old.value.requestHash === requestHash, 'idempotency_conflict'); return visible(tx, old); }
        const active = (await tx.read('active-builds', projectId))?.value;
        if (active) {
          const job = (await tx.read('workflow-jobs', active.id))?.value;
          requireThat(!job || ['complete', 'failed', 'blocked', 'cancelled'].includes(job.state), 'build_in_progress');
        }
        for (const [scope, maximum] of [[projectId, await limit('buildsPerProjectDay', tx) ?? limits.projectPerDay], ['global', await limit('buildsPerDay', tx) ?? limits.globalPerDay]]) {
          const key = digest({ scope, day: Math.floor(now() / 86400000), version: limits.version });
          const count = await tx.read('build-admission', key);
          requireThat((count?.value.count ?? 0) < maximum, 'capacity_reached');
          await tx.write('build-admission', key, { count: (count?.value.count ?? 0) + 1 }, count?.revision ?? 0);
        }
        // Old workers claim only `compile`. Keep new-profile jobs outside that
        // queue so an in-flight old deployment cannot silently drop selection.
        const extended = payload.compilerProfile !== undefined || payload.sourceRoot !== undefined;
        const job = await jobs.enqueue(tx, { projectId, kind: extended ? 'compile-profile-v2' : 'compile',
          payload: extended ? { ...payload, buildId: id } : payload, idempotencyKey, authority: { actor } });
        const value = { id, ...(extended ? { jobId: job.id } : {}), projectId, ...payload, requestHash, state: 'queued', artifactHash: null,
          admissionVersion: limits.version, createdAt: now() };
        await tx.write('builds', value.id, value, 0);
        const last = await tx.read('active-builds', projectId);
        await tx.write('active-builds', projectId, { id: job.id }, last?.revision ?? 0);
        return value;
      });
    },
    async get(actor, projectId, id) {
      await identity.authorize(actor, 'artifact.read', { projectId });
      return visible(store, await find(store, projectId, id));
    },
    async artifact(actor, projectId, id) {
      await identity.authorize(actor, 'artifact.read', { projectId });
      const build = (await find(store, projectId, id)).value;
      requireThat(build.artifactHash, 'build_not_complete');
      return artifacts.get(projectId, build.artifactHash);
    },
    async runOne(compile) {
      const claim = await jobs.claim({ kinds: ['compile', 'compile-profile-v2'], leaseMs: 120000 });
      if (claim.idle) return claim;
      const { projectId, authority: { actor }, payload } = claim.job;
      const buildId = payload.buildId ?? claim.id;
      const authorized = tx => identity.allowed(actor, 'build.compile', { projectId }, tx);
      try {
        if (claim.mode === 'dispatch') await jobs.beginEffect(claim, (_job, tx) => authorized(tx));
        else requireThat(await authorized(store), 'effect_not_authorized');
        const files = await projects.files(actor, projectId, payload.snapshotId);
        // Recompiling after a crash is safe: this kind executes no constructor,
        // project scripts, network writes or financial action.
        const result = await compile({ files, entry: payload.entry, contract: payload.contract,
          ...(payload.compilerProfile ? { compilerProfile: payload.compilerProfile } : {}),
          ...(payload.sourceRoot === undefined ? {} : { sourceRoot: payload.sourceRoot }) });
        requireThat(['compiled', 'rejected'].includes(result?.status), 'invalid_build_result');
        return await jobs.finish(claim, { state: result.status === 'compiled' ? 'complete' : 'failed',
          result: { status: result.status } }, async tx => {
          requireThat(await authorized(tx), 'effect_not_authorized');
          const old = await find(tx, projectId, buildId);
          const artifactHash = await artifacts.put(tx, projectId, result);
          await tx.write('builds', buildId, { ...old.value, state: result.status, artifactHash,
            completedAt: now(), error: null, evidenceLevel: 'compiled_only' }, old.revision);
        });
      } catch (error) {
        if (error.code === 'lease_lost') return { stale: true };
        const transient = ['r2_read_unavailable','r2_source_read_unavailable'].includes(error.code);
        const code = ['scope_denied', 'effect_not_authorized', 'unauthenticated'].includes(error.code) ? 'authorization_revoked' :
          transient ? 'source_temporarily_unavailable' : ['compiler_timeout', 'compiler_failed', 'artifact_too_large'].includes(error.code) ? error.code : 'build_failed';
        const state = transient ? 'waiting' : code === 'authorization_revoked' ? 'blocked' : 'failed';
        const retryAt = transient ? now() + Math.min(900000,30000*2**Math.min(5,Math.max(0,claim.job.attempts-1))) : null;
        try {
          return await jobs.finish(claim, { state, retryAt, result: { error: code } }, async tx => {
            const old = await find(tx, projectId, buildId);
            await tx.write('builds', buildId, { ...old.value, state, error: code, ...(transient ? {} : { completedAt: now() }) }, old.revision);
          });
        } catch (finishError) { if (finishError.code === 'lease_lost') return { stale: true }; throw finishError; }
      }
    }
  };
}
