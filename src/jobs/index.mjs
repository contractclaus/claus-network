import { randomBytes } from 'node:crypto';
import { copy, digest, integer, requireThat, text } from '../shared/index.mjs';

// A lease protects local commits. The effect key protects the external action.
// After an uncertain send, only reconciliation may run, even after a restart.
export function createJobs({ store, identity, now = () => Date.now(), onCancel = async () => {} }) {
  const publicJob = record => {
    const { lease, payload, authority, ...visible } = record.value;
    return { ...visible, revision: record.revision };
  };
  async function owned(reader, projectId, id) {
    const record = await reader.read('workflow-jobs', text(id));
    requireThat(record?.value.projectId === projectId, 'not_found');
    return record;
  }
  async function leased(tx, claim) {
    const record = await tx.read('workflow-jobs', claim.id);
    requireThat(record && record.value.lease?.token === claim.token &&
      record.value.lease.until > now(), 'lease_lost');
    return record;
  }
  return {
    // Internal admission port. Hosts must authorize and reserve money in this
    // same transaction before enqueuing work that can incur a charge.
    async enqueue(tx, { projectId, kind, payload, idempotencyKey, authority }) {
      text(projectId); text(kind); text(idempotencyKey);
      const id = digest({ projectId, kind, idempotencyKey });
      const requestHash = digest({ payload, authority });
      const existing = await tx.read('workflow-jobs', id);
      if (existing) {
        requireThat(existing.value.requestHash === requestHash, 'idempotency_conflict');
        return publicJob(existing);
      }
      const value = { id, projectId, kind, payload: copy(payload), authority: copy(authority), requestHash,
        state: 'queued', effect: 'not_started', effectKey: id, attempts: 0,
        availableAt: now(), createdAt: now(), updatedAt: now(), lease: null, result: null };
      const record = await tx.write('workflow-jobs', id, value, 0);
      await tx.event({ type: 'job.queued', jobId: id, projectId, kind, at: now() });
      return publicJob(record);
    },
    async get(actor, projectId, id) {
      await identity.authorize(actor, 'review.read', { projectId });
      return publicJob(await owned(store, projectId, id));
    },
    async cancel(actor, projectId, id) {
      return store.transaction(async tx => {
        await identity.authorize(actor, 'job.cancel', { projectId }, tx);
        const record = await owned(tx, projectId, id);
        if (record.value.state === 'cancelled') return publicJob(record);
        requireThat(record.value.effect === 'not_started', 'effect_requires_reconciliation');
        requireThat(!['complete', 'failed'].includes(record.value.state), 'job_terminal');
        await onCancel(tx, copy(record.value));
        const next = await tx.write('workflow-jobs', id, { ...record.value, state: 'cancelled',
          lease: null, updatedAt: now() }, record.revision);
        await tx.event({ type: 'job.cancelled', jobId: id, projectId, at: now() });
        return publicJob(next);
      });
    },
    // These worker ports are not exposed by HTTP/MCP. A runtime supplies the
    // supported kinds; a project cannot select a module, command or callback.
    async claim({ kinds, leaseMs = 60000, after = '' }) {
      integer(leaseMs, 1000, 300000);
      requireThat(Array.isArray(kinds) && kinds.length > 0, 'invalid_job_kinds');
      return store.transaction(async tx => {
        // Advance after each claim so a waiting job cannot monopolize its lane.
        // Scan at most 1,000 rows and wrap once to retain prompt reconciliation.
        const scanKey = digest([...kinds].sort());
        const scan = after ? null : await tx.read('job-scan-cursors', scanKey);
        const start = after || scan?.value.after || '';
        const records = await tx.list('workflow-jobs', { after: start, limit: 1000 });
        if (!after && start && records.length < 1000) {
          const wrapped = await tx.list('workflow-jobs', { limit: 1000 - records.length });
          records.push(...wrapped.filter(record => record.id <= start));
        }
        const nextCursor = records.length === 1000 ? records.at(-1).id : '';
        for (const record of records) {
          const value = record.value;
          if (!kinds.includes(value.kind) || !['queued', 'running', 'waiting'].includes(value.state) ||
            value.availableAt > now() || (value.lease && value.lease.until > now())) continue;
          const token = randomBytes(24).toString('hex');
          const next = { ...value, state: 'running', attempts: value.attempts + 1,
            lease: { token, until: now() + leaseMs }, updatedAt: now() };
          await tx.write('workflow-jobs', value.id, next, record.revision);
          if (!after) await tx.write('job-scan-cursors', scanKey, { after: value.id }, scan?.revision ?? 0);
          return { id: value.id, token, job: copy(next), mode: value.effect === 'not_started' ? 'dispatch' : 'reconcile' };
        }
        if (!after) await tx.write('job-scan-cursors', scanKey, { after: nextCursor }, scan?.revision ?? 0);
        return { idle: true, nextCursor: nextCursor || null };
      });
    },
    async beginEffect(claim, authorizeEffect) {
      return store.transaction(async tx => {
        const record = await leased(tx, claim);
        requireThat(record.value.effect === 'not_started', 'effect_already_started');
        requireThat(await authorizeEffect(copy(record.value), tx) === true, 'effect_not_authorized');
        const value = { ...record.value, effect: 'outcome_unknown', updatedAt: now() };
        await tx.write('workflow-jobs', claim.id, value, record.revision);
        await tx.event({ type: 'job.effect_intent', jobId: claim.id, projectId: value.projectId,
          effectKey: value.effectKey, at: now() });
        return copy(value);
      });
    },
    async assertCurrent(claim, reader = store) {
      return copy((await leased(reader, claim)).value);
    },
    async finish(claim, { state, result = null, retryAt = null }, commit = async () => {}) {
      requireThat(['complete', 'failed', 'waiting', 'blocked'].includes(state), 'invalid_job_result');
      if (state === 'waiting') integer(retryAt, now() + 1000);
      return store.transaction(async tx => {
        const record = await leased(tx, claim);
        await commit(tx, copy(record.value));
        const value = { ...record.value, state, result: copy(result), lease: null,
          availableAt: retryAt ?? now(), updatedAt: now() };
        await tx.write('workflow-jobs', claim.id, value, record.revision);
        await tx.event({ type: 'job.' + state, jobId: claim.id, projectId: value.projectId, at: now() });
        return publicJob({ value, revision: record.revision + 1 });
      });
    }
  };
}
