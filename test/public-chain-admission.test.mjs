import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/storage/index.mjs';
import { createChainAdmission } from '../src/chain-deployments/index.mjs';
import { digest } from '../src/shared/index.mjs';

test('public chain scope pins reviewed artifacts and accounts gas without resetting on policy changes', async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  let time = 1800000000000;
  const address = '0x' + '11'.repeat(20), executor = '0x' + '22'.repeat(20);
  const config = { enabled: true, expiresAt: time + 1000000, executor, executorCodeHash: '0x' + '33'.repeat(32),
    targetArtifactHash: digest('target'), reviewProjectId: 'reviewer', reviewCaseId: 'review', reviewArtifactHash: digest('review'),
    maximumProjects: 1, maximumTransactionGasWei: '5', maximumProjectGasWei: '8', maximumTotalGasWei: '8' };
  const identity = { credential: async actor => ({ kind: actor === 'owner' ? 'owner' : 'agent', principalId: 'principal' }) };
  const admission = createChainAdmission({ store, identity, now: () => time });
  await store.transaction(async tx => {
    await tx.write('network', 'authority', { ownerAddress: address }, 0);
    await tx.write('principals', 'principal', { address, chainId: 1 }, 0);
    await tx.write('network-capabilities', 'chain', { enabled: true, profile: 'claus-readonly-v1', chainId: 11155111,
      executor, executorCodeHash: config.executorCodeHash, targetArtifactHash: config.targetArtifactHash }, 0);
    await tx.write('review-cases', 'review', { projectId: 'reviewer', state: 'reviewed', artifactHash: config.reviewArtifactHash, input: { buildHash: digest('executor') } }, 0);
  });
  await assert.rejects(admission.publish('agent', { version: 'open', config }), { code: 'scope_denied' });
  await admission.publish('owner', { version: 'open', config });
  await admission.activate('owner', { version: 'open', expectedGeneration: 0 });
  await assert.rejects(admission.admitted(), { code: 'chain_scope_not_reviewed' });
  await store.transaction(tx => tx.write('chain-admission-assessments', digest({ executor,
    targetArtifactHash: config.targetArtifactHash, reviewCaseId: config.reviewCaseId }), {
    accepted: true, publicAdmission: true, chainId: 11155111,
    executorCodeHash: config.executorCodeHash, reviewArtifactHash: config.reviewArtifactHash,
    reviewedBuildHash: digest('executor')
  }, 0));
  await store.transaction(tx => admission.reserveProject(tx, 'p1'));
  await assert.rejects(store.transaction(tx => admission.reserveProject(tx, 'p2')), { code: 'capacity_reached' });
  const reserve = (id, maximum) => store.transaction(tx => admission.reserveGas(tx, { id, maximum, intent: { authority: { projectId: 'p1' } } }));
  await reserve('tx1', '5');
  await assert.rejects(reserve('tx2', '5'), { code: 'chain_gas_exhausted' });
  await store.transaction(tx => admission.finalizeGas(tx, { id: 'tx1', actual: '3' }));
  await store.transaction(tx => admission.finalizeGas(tx, { id: 'tx1', actual: '3' }));
  await admission.publish('owner', { version: 'again', config });
  await admission.activate('owner', { version: 'again', expectedGeneration: 1 });
  assert.equal((await admission.get('owner')).usage.spent, '3');
  await reserve('tx2', '5');
  time += 1000001;
  await assert.rejects(admission.admitted(), { code: 'chain_public_not_enabled' });
  // Expiry must not prevent reconciliation of a transaction already sent.
  await store.transaction(tx => admission.finalizeGas(tx, { id: 'tx2', actual: '4' }));
  assert.deepEqual((await admission.get('owner')).usage, { projects: 1, reserved: '0', spent: '7' });
});
