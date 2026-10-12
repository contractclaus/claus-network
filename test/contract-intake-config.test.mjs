import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/storage/index.mjs';
import { digest } from '../src/shared/index.mjs';
import { contractIntakePorts, contractIntakeHealth } from '../runtime/contract-intake-config.mjs';

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
  await set('network-capabilities', 'contract-intake', { enabled: true, profileHash: digest(pin), projectIds: ['pilot-project'] });
  await assert.rejects(ports.verifyAdmission(store), { code: 'intake_review_not_admitted' });
  await set('contract-intake-admissions', digest(pin), { accepted: true, profileHash: digest(pin) });
  await set('review-cases', pin.reviewCaseId, { projectId: pin.reviewProjectId, state: 'reviewed', artifactHash: pin.reviewArtifactHash });
  assert.equal(await ports.verifyAdmission(store), true);
  assert.equal(await ports.verifyAdmission(store, 'pilot-project'), true);
  assert.equal(await ports.verifyAdmission(store, 'unadmitted-project'), false);
  await set('network-capabilities', 'contract-intake', { enabled: true, profileHash: digest(pin) });
  await assert.rejects(ports.verifyAdmission(store, 'pilot-project'), { code: 'intake_projects_not_admitted' });
  await set('network-capabilities', 'contract-intake', { enabled: true, profileHash: digest(pin), projectIds: ['pilot-project'] });
  await set('review-cases', pin.reviewCaseId, { projectId: pin.reviewProjectId, state: 'reviewed', artifactHash: digest('changed-report') });
  await assert.rejects(ports.verifyAdmission(store), { code: 'intake_review_not_admitted' });
  await set('network-capabilities', 'contract-intake', { enabled: false, profileHash: digest(pin) });
  assert.equal(await ports.verifyAdmission(store), false);
  await set('network-capabilities', 'contract-intake', { enabled: true, profileHash: digest({ ...pin, startBlock: 2 }) });
  await assert.rejects(ports.verifyAdmission(store), { code: 'intake_admission_changed' });
  assert.throws(() => contractIntakePorts({ CLAUS_CONTRACT_INTAKE_PROFILE: JSON.stringify({ ...pin, chainId: 1 }) }), { code: 'unsupported_chain' });
});

test('intake health isolates withdrawn admissions and requires the exact fresh worker release and inbox', async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  const now = Date.now(), pin = { fixture: 'deployment' };
  const ports = { enabled: true, pin, verifyAdmission: async () => true };
  const set = async (collection, value) => store.transaction(async tx => {
    const old = await tx.read(collection, 'contract-intake');
    await tx.write(collection, 'contract-intake', value, old?.revision ?? 0);
  });
  assert.equal(await contractIntakeHealth(store, {}), 'not_enabled');
  await set('network-capabilities', { workerRelease: 'release-a' });
  await set('worker-health', { state: 'active', observedAt: now, profileHash: digest(pin), release: 'release-a' });
  assert.equal(await contractIntakeHealth(store, ports, now), 'restricted_pilot');
  await set('worker-health', { state: 'active', observedAt: now, profileHash: digest({ other: true }), release: 'release-a' });
  assert.equal(await contractIntakeHealth(store, ports, now), 'worker_unavailable');
  await set('worker-health', { state: 'active', observedAt: now, profileHash: digest(pin), release: 'old-release' });
  assert.equal(await contractIntakeHealth(store, ports, now), 'worker_unavailable');
  await set('worker-health', { state: 'active', observedAt: now - 300001, profileHash: digest(pin), release: 'release-a' });
  assert.equal(await contractIntakeHealth(store, ports, now), 'worker_unavailable');
  ports.verifyAdmission = async () => { throw Object.assign(Error('withdrawn'), { code: 'intake_review_not_admitted' }); };
  assert.equal(await contractIntakeHealth(store, ports, now), 'admission_unavailable');
  ports.verifyAdmission = async () => { throw Error('database unavailable'); };
  await assert.rejects(contractIntakeHealth(store, ports, now), /database unavailable/);
});
