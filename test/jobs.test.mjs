import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/storage/index.mjs';
import { createJobs } from '../src/jobs/index.mjs';
import { createSealer } from '../adapters/secrets.mjs';

async function fixture(t) {
  const store = openStore(':memory:'); t.after(() => store.close());
  let time = 1800000000000;
  const jobs = createJobs({ store, now: () => time, identity: { authorize: async () => {} } });
  const enqueue = (input = {}) => store.transaction(tx => jobs.enqueue(tx, { projectId: 'project', kind: 'review',
    payload: { source: 'fixed' }, idempotencyKey: 'one', authority: { generation: 1 }, ...input }));
  return { store, jobs, enqueue, advance: ms => { time += ms; }, now: () => time };
}
test('atomic enqueue, conflicting requests, expired lease and uncertain effects preserve one action identity', async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.enqueue(), f.enqueue()]); assert.equal(a.id, b.id);
  await assert.rejects(f.enqueue({ payload: { source: 'changed' } }), { code: 'idempotency_conflict' });
  const first = await f.jobs.claim({ kinds: ['review'], leaseMs: 1000 });
  assert.equal(first.mode, 'dispatch');
  assert.equal((await f.jobs.claim({ kinds: ['review'] })).idle, true);
  await f.jobs.beginEffect(first, async () => true);
  f.advance(1001);
  const second = await f.jobs.claim({ kinds: ['review'] });
  assert.equal(second.mode, 'reconcile'); assert.equal(second.job.effectKey, first.job.effectKey);
  await assert.rejects(f.jobs.finish(first, { state: 'complete' }), { code: 'lease_lost' });
  await assert.rejects(f.jobs.beginEffect(second, async () => true), { code: 'effect_already_started' });
  await f.jobs.finish(second, { state: 'complete', result: { receipt: 'original-provider-order' } });
  const visible = await f.jobs.get('owner', 'project', a.id);
  assert.equal(visible.state, 'complete'); assert.equal(visible.payload, undefined); assert.equal(visible.lease, undefined);
});
test('revocation prevents dispatch but cannot cancel away an uncertain paid effect', async t => {
  const f = await fixture(t), job = await f.enqueue();
  const c = await f.jobs.claim({ kinds: ['review'] });
  await assert.rejects(f.jobs.beginEffect(c, async () => false), { code: 'effect_not_authorized' });
  assert.equal((await f.jobs.get('x', 'project', job.id)).effect, 'not_started');
  await f.jobs.beginEffect(c, async () => true);
  await assert.rejects(f.jobs.cancel('x', 'project', job.id), { code: 'effect_requires_reconciliation' });
  await f.jobs.finish(c, { state: 'waiting', retryAt: f.now() + 2000 });
  assert.equal((await f.jobs.claim({ kinds: ['review'] })).idle, true);
  f.advance(2001); assert.equal((await f.jobs.claim({ kinds: ['review'] })).mode, 'reconcile');
});
test('cancellation before dispatch invalidates an acquired lease; failed receipt commit is atomic', async t => {
  const f = await fixture(t), job = await f.enqueue();
  const c = await f.jobs.claim({ kinds: ['review'] });
  await f.jobs.cancel('x', 'project', job.id);
  await assert.rejects(f.jobs.beginEffect(c, async () => true), { code: 'lease_lost' });
  await f.enqueue({ idempotencyKey: 'next' });
  const next = await f.jobs.claim({ kinds: ['review'] });
  await assert.rejects(f.jobs.finish(next, { state: 'complete' }, async tx => {
    await tx.write('receipt', 'one', { valid: true }, 0); throw Error('lost');
  }), /lost/);
  assert.equal(await f.store.read('receipt', 'one'), null);
  assert.equal((await f.jobs.get('x', 'project', next.id)).state, 'running');
});
test('sealed provider credentials cannot be copied between orders or read with another key', () => {
  const s = createSealer('01'.repeat(32)), value = s.seal('order-a', { token: 'private-token' });
  assert.equal(JSON.stringify(value).includes('private-token'), false);
  assert.deepEqual(s.open('order-a', value), { token: 'private-token' });
  assert.throws(() => s.open('order-b', value), { code: 'sealed_record_unavailable' });
  assert.throws(() => createSealer('02'.repeat(32)).open('order-a', value), { code: 'sealed_record_unavailable' });
});
