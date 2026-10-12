import { digest, requireThat, text } from '../shared/index.mjs';

export function createBuilds({ store, identity, projects, jobs, artifacts, now = () => Date.now(),
  limits = { version: 'compile-admission-v1', projectPerDay: 16, globalPerDay: 256 } }) {
  async function find(reader, projectId, id) {
    const record = await reader.read('builds', text(id));
    requireThat(record?.value.projectId === projectId, 'not_found');
    return record;
  }
  async function visible(reader, record) {
    const job = (await reader.read('workflow-jobs', record.value.id))?.value;
    return job?.state === 'cancelled' ? { ...record.value, state: 'cancelled', completedAt: job.updatedAt } : record.value;
  }
  return {
    async submit(actor, projectId, { snapshotId, entry, contract, idempotencyKey }) {
      text(idempotencyKey);
      requireThat(typeof contract === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(contract), 'invalid_contract');
      const snapshot = await projects.snapshot(actor, projectId, snapshotId);
      requireThat(snapshot.files.some(file => file.path === entry && entry.endsWith('.sol')), 'entry_missing');
      return store.transaction(async tx => {
        await identity.authorize(actor, 'build.compile', { projectId }, tx);
        const id = digest({ projectId, kind: 'compile', idempotencyKey });
        const payload = { snapshotId, entry, contract }, requestHash = digest(payload);
        const old = await tx.read('builds', id);
        if (old) { requireThat(old.value.requestHash === requestHash, 'idempotency_conflict'); return visible(tx, old); }
        const active = (await tx.read('active-builds', projectId))?.value;
        if (active) {
          const job = (await tx.read('workflow-jobs', active.id))?.value;
          requireThat(!job || ['complete', 'failed', 'blocked', 'cancelled'].includes(job.state), 'build_in_progress');
        }
        for (const [scope, maximum] of [[projectId, limits.projectPerDay], ['global', limits.globalPerDay]]) {
          const key = digest({ scope, day: Math.floor(now() / 86400000), version: limits.version });
          const count = await tx.read('build-admission', key);
          requireThat((count?.value.count ?? 0) < maximum, 'capacity_reached');
          await tx.write('build-admission', key, { count: (count?.value.count ?? 0) + 1 }, count?.revision ?? 0);
        }
        const job = await jobs.enqueue(tx, { projectId, kind: 'compile', payload, idempotencyKey, authority: { actor } });
        const value = { id: job.id, projectId, ...payload, requestHash, state: 'queued', artifactHash: null,
          admissionVersion: limits.version, createdAt: now() };
        await tx.write('builds', value.id, value, 0);
        const last = await tx.read('active-builds', projectId);
        await tx.write('active-builds', projectId, { id: value.id }, last?.revision ?? 0);
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
      const claim = await jobs.claim({ kinds: ['compile'], leaseMs: 120000 });
      if (claim.idle) return claim;
      const { projectId, authority: { actor }, payload } = claim.job;
      const authorized = tx => identity.allowed(actor, 'build.compile', { projectId }, tx);
      try {
        if (claim.mode === 'dispatch') await jobs.beginEffect(claim, (_job, tx) => authorized(tx));
        else requireThat(await authorized(store), 'effect_not_authorized');
        const files = await projects.files(actor, projectId, payload.snapshotId);
        // Recompiling after a crash is safe: this kind executes no constructor,
        // project scripts, network writes or financial action.
        const result = await compile({ files, entry: payload.entry, contract: payload.contract });
        requireThat(['compiled', 'rejected'].includes(result?.status), 'invalid_build_result');
        return await jobs.finish(claim, { state: result.status === 'compiled' ? 'complete' : 'failed',
          result: { status: result.status } }, async tx => {
          requireThat(await authorized(tx), 'effect_not_authorized');
          const old = await find(tx, projectId, claim.id);
          const artifactHash = await artifacts.put(tx, projectId, result);
          await tx.write('builds', claim.id, { ...old.value, state: result.status, artifactHash,
            completedAt: now(), evidenceLevel: 'compiled_only' }, old.revision);
        });
      } catch (error) {
        if (error.code === 'lease_lost') return { stale: true };
        const code = ['scope_denied', 'effect_not_authorized', 'unauthenticated'].includes(error.code) ? 'authorization_revoked' :
          ['compiler_timeout', 'compiler_failed', 'artifact_too_large'].includes(error.code) ? error.code : 'build_failed';
        return jobs.finish(claim, { state: code === 'authorization_revoked' ? 'blocked' : 'failed', result: { error: code } }, async tx => {
          const old = await find(tx, projectId, claim.id);
          await tx.write('builds', claim.id, { ...old.value, state: 'failed', error: code, completedAt: now() }, old.revision);
        });
      }
    }
  };
}
