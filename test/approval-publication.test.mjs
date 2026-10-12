import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/storage/index.mjs';
import { createApprovals } from '../src/approvals/index.mjs';

async function fixture(t, published = true) {
  const store = openStore(':memory:'); t.after(() => store.close());
  const projectId = 'local-project', id = 'local-proposal';
  await store.transaction(async tx => {
    await tx.write('chain-proposals', id, { id, projectId, state: 'queued', inputArtifactHash: 'input' }, 0);
    await tx.write('proposal-publications', id, { published }, 0);
    await tx.write('public-evidence', projectId, { reviews: [{ id: 'original-review' }],
      decisions: published ? [{ id, status: 'Approved' }] : [], deployments: [] }, 0);
  });
  const claim = { mode: 'reconcile', job: { projectId, payload: { proposalId: id }, authority: { actor: 'local-actor' } } };
  const jobs = { claim: async () => claim, assertCurrent: async () => {},
    finish: async (_claim, result, change) => store.transaction(async tx => { await change(tx); return result; }) };
  const approvals = createApprovals({ store, jobs, identity: { authorize: async () => {} },
    deployments: { allowed: async () => {} }, artifacts: { get: async () => ({ evidence: { chain: {} } }) } });
  const result = { state: 'executed', execution: { chainId: 11155111, address: '0x' + '11'.repeat(20),
    transactionHash: '0x' + '22'.repeat(32), verification: { state: 'verified', localFixture: true } } };
  return { store, approvals, projectId, id, result };
}

test('a published approval gains its execution evidence without another publication request', async t => {
  const f = await fixture(t);
  await f.approvals.runExecution({ step: async () => f.result });
  const evidence = (await f.store.read('public-evidence', f.projectId)).value;
  assert.equal(evidence.deployments.length, 1);
  assert.equal(evidence.deployments[0].transactionHash, f.result.execution.transactionHash);
  assert.equal(evidence.deployments[0].verification, 'verified');
  assert.deepEqual(evidence.reviews, [{ id: 'original-review' }]);
  assert.deepEqual(evidence.decisions, [{ id: f.id, status: 'Approved' }]);
  assert.equal((await f.store.read('proposal-publications', f.id)).revision, 1);
});

test('unpublished, withdrawn and unfinished execution results do not become public deployments', async t => {
  for (const mode of ['unpublished', 'withdrawn-during-reconcile', 'pending']) {
    const f = await fixture(t, mode !== 'unpublished');
    await f.approvals.runExecution({ step: async () => {
      if (mode === 'withdrawn-during-reconcile') await f.store.transaction(async tx => {
        const publication = await tx.read('proposal-publications', f.id);
        await tx.write('proposal-publications', f.id, { published: false }, publication.revision);
        const evidence = await tx.read('public-evidence', f.projectId);
        await tx.write('public-evidence', f.projectId, { ...evidence.value, decisions: [] }, evidence.revision);
      });
      return mode === 'pending' ? { state: 'queued', readyAt: 1800000000 } : f.result;
    } });
    assert.deepEqual((await f.store.read('public-evidence', f.projectId)).value.deployments, []);
  }
});
