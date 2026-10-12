import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/storage/index.mjs';
import { publicDecisionCapacity } from '../src/approvals/limits.mjs';
import { createApprovals } from '../src/approvals/index.mjs';

test('public decision limits are atomic and lifetime use survives a new day', async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  await store.transaction(tx => tx.write('public-chain-projects', 'p1', {}, 0));
  let now = 1800000000000;
  const submit = () => store.transaction(tx => publicDecisionCapacity(tx, 'p1', now, true));
  const concurrent = await Promise.allSettled([submit(), submit(), submit()]);
  assert.equal(concurrent.filter(x => x.status === 'fulfilled').length, 2);
  assert.equal(concurrent.find(x => x.status === 'rejected').reason.code, 'decision_capacity_reached');
  assert.equal(concurrent.find(x => x.status === 'rejected').reason.retryAt, (Math.floor(now / 86400000) + 1) * 86400000);
  now += 86400000; await submit(); await submit(); now += 86400000;
  await assert.rejects(submit(), error => error.code === 'decision_capacity_reached' && error.retryAt === undefined);
  await store.transaction(async tx => {
    await tx.write('review-pilots', 'existing-pilot', { enabled: true, expiresAt: now + 10000 }, 0);
    assert.equal(await publicDecisionCapacity(tx, 'existing-pilot', now, true), false);
  });
  const approvals = createApprovals({ store, now: () => now, identity: {
    authorize: async () => {}, credential: async () => ({ kind: 'owner' })
  }, deployments: { allowed: async () => {} } });
  await store.transaction(tx => tx.write('public-chain-projects', 'p2', {}, 0));
  await assert.rejects(approvals.create('owner', 'p2', { moduleId: 'm', configuration: '0x', idempotencyKey: 'owner' }),
    { code: 'durable_agent_required' });
});

test('expired pilot decisions require an agent and consume public limits before any gas enrollment', async t => {
  const store = openStore(':memory:'); t.after(() => store.close()); const now = 1800000000000;
  await store.transaction(tx => tx.write('review-pilots', 'expired', { enabled: true, expiresAt: now - 1 }, 0));
  const approvals = createApprovals({ store, now: () => now, identity: {
    authorize: async () => {}, credential: async () => ({ kind: 'owner' })
  }, deployments: { allowed: async () => {} } });
  await assert.rejects(approvals.create('owner', 'expired', { moduleId: 'm', configuration: '0x', idempotencyKey: 'expired-owner' }),
    { code: 'durable_agent_required' });
  for (let n = 0; n < 2; n++) await store.transaction(tx => publicDecisionCapacity(tx, 'expired', now, true));
  await assert.rejects(store.transaction(tx => publicDecisionCapacity(tx, 'expired', now, true)), { code: 'decision_capacity_reached' });
  assert.equal(await store.read('public-chain-projects', 'expired'), null);
});
