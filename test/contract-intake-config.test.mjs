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
  assert.throws(() => contractIntakePorts({ CLAUS_CONTRACT_INTAKE_PROFILE: JSON.stringify({ ...pin, chainId: 1 }) }), { code: 'historical_rpc_required' });
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

test('explicit chain list isolates identical inbox addresses, admission withdrawal and worker health', async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  const pins = [11155111, 1].map(chainId => ({ chainId, inbox: '0x' + '11'.repeat(20), dispatcher: '0x' + '22'.repeat(20),
    codeHash: '0x' + '33'.repeat(32), startBlock: 1, reviewProjectId: 'review-project',
    reviewCaseId: 'review-case', reviewArtifactHash: digest('report') }));
  const env = { CLAUS_CONTRACT_INTAKE_PROFILES: JSON.stringify(pins), CLAUS_MAINNET_RPC_URL: 'https://mainnet.example' };
  const ports = contractIntakePorts(env, new Map(pins.map(p => [p.chainId, {}])));
  const now = Date.now();
  await store.transaction(async tx => {
    await tx.write('review-cases', 'review-case', { projectId: 'review-project', state: 'reviewed', artifactHash: digest('report') }, 0);
    for (const pin of pins) {
      const projectId = 'project-' + pin.chainId, key = 'contract-intake:' + pin.chainId;
      await tx.write('chain-bindings', projectId, { chainId: pin.chainId }, 0);
      await tx.write('contract-intake-admissions', digest(pin), { accepted: true, profileHash: digest(pin) }, 0);
      await tx.write('network-capabilities', key, { enabled: true, profileHash: digest(pin), projectIds: [projectId], workerRelease: 'new' }, 0);
      await tx.write('worker-health', key, { state: 'active', observedAt: now, profileHash: digest(pin), release: 'new' }, 0);
    }
  });
  for (const pin of pins) {
    assert.equal((await ports.chain.profile(pin.chainId)).chainId, pin.chainId);
    assert.equal(await ports.verifyAdmission(store, 'project-' + pin.chainId), true);
    assert.equal(await contractIntakeHealth(store, ports, now, pin.chainId), 'restricted_pilot');
  }
  assert.equal(await ports.byChain.get(1).verifyAdmission(store, 'project-11155111'), false);
  await store.transaction(tx => tx.write('network-capabilities', 'contract-intake:1', { enabled: false }, 1));
  assert.equal(await ports.verifyAdmission(store, 'project-1'), false);
  assert.equal(await contractIntakeHealth(store, ports, now, 1), 'not_enabled');
  assert.equal(await contractIntakeHealth(store, ports, now, 11155111), 'restricted_pilot');
  assert.throws(() => contractIntakePorts({ ...env, CLAUS_CONTRACT_INTAKE_PROFILE: JSON.stringify(pins[0]) }), { code: 'ambiguous_intake_profiles' });
  assert.throws(() => contractIntakePorts({ ...env, CLAUS_CONTRACT_INTAKE_PROFILES: JSON.stringify([pins[0], pins[0]]) }), { code: 'invalid_intake_profiles' });
});

test('Sepolia migration preserves original records and never promotes stale health',async t=>{
 const {migrateSepoliaIntake}=await import('../integration/intake-migration.mjs');
 const store=openStore(':memory:');t.after(()=>store.close());const profileHash=digest('old-pin');
 await store.transaction(async tx=>{
  await tx.write('network-capabilities','contract-intake',{enabled:true,profileHash,workerRelease:'old'},0);
  await tx.write('worker-health','contract-intake',{observedAt:1,state:'active'},0);
  await tx.write('contract-intake-cursors','original',{afterBlock:99},0);
 });
 await assert.rejects(migrateSepoliaIntake(store,{profileHash,expectedRevision:2}),{code:'intake_admission_changed'});
 assert.equal((await migrateSepoliaIntake(store,{profileHash,expectedRevision:1})).state,'migrated');
 assert.equal((await migrateSepoliaIntake(store,{profileHash,expectedRevision:1})).state,'already_migrated');
 assert.deepEqual((await store.read('contract-intake-cursors','original')).value,{afterBlock:99});
 assert.equal(await store.read('worker-health','contract-intake:11155111'),null);
 assert.equal((await store.read('network-capabilities','contract-intake')).revision,1);
});
