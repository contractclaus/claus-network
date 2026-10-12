import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/storage/index.mjs';
import { digest } from '../src/shared/index.mjs';
import { contractIntakePorts } from '../runtime/contract-intake-config.mjs';

test('host pin requires the exact independently reviewed deployment admission; withdrawal disables new work', async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  assert.deepEqual(contractIntakePorts({}), {});
  const pin = { chainId: 11155111, inbox: '0x' + '11'.repeat(20), dispatcher: '0x' + '22'.repeat(20),
    codeHash: '0x' + '33'.repeat(32), startBlock: 1, reviewProjectId: 'review-project',
    reviewCaseId: 'review-case', reviewArtifactHash: digest('report') };
  const ports = contractIntakePorts({ CLAUS_CONTRACT_INTAKE_PROFILE: JSON.stringify(pin) }, {});
  assert.equal(await ports.verifyAdmission(store), false);
  const set = async (collection, id, value) => store.transaction(async tx => {
    const old = await tx.read(collection, id); await tx.write(collection, id, value, old?.revision ?? 0);
  });
  await set('network-capabilities', 'contract-intake', { enabled: true, profileHash: digest(pin) });
  await assert.rejects(ports.verifyAdmission(store), { code: 'intake_review_not_admitted' });
  await set('contract-intake-admissions', digest(pin), { accepted: true, profileHash: digest(pin) });
  await set('review-cases', pin.reviewCaseId, { projectId: pin.reviewProjectId, state: 'reviewed', artifactHash: pin.reviewArtifactHash });
  assert.equal(await ports.verifyAdmission(store), true);
  await set('review-cases', pin.reviewCaseId, { projectId: pin.reviewProjectId, state: 'reviewed', artifactHash: digest('changed-report') });
  await assert.rejects(ports.verifyAdmission(store), { code: 'intake_review_not_admitted' });
  await set('network-capabilities', 'contract-intake', { enabled: false, profileHash: digest(pin) });
  assert.equal(await ports.verifyAdmission(store), false);
  await set('network-capabilities', 'contract-intake', { enabled: true, profileHash: digest({ ...pin, startBlock: 2 }) });
  await assert.rejects(ports.verifyAdmission(store), { code: 'intake_admission_changed' });
  assert.throws(() => contractIntakePorts({ CLAUS_CONTRACT_INTAKE_PROFILE: JSON.stringify({ ...pin, chainId: 1 }) }), { code: 'unsupported_chain' });
});
