import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { openStore } from '../src/storage/index.mjs';
import { createApplication } from '../runtime/server.mjs';
import { archiveKeyId, createProjectArchives, verifyProjectArchive } from '../src/portability/index.mjs';
import { digest } from '../src/shared/index.mjs';

async function fixture(t) {
  const store = openStore(':memory:'); t.after(() => store.close());
  const app = createApplication({ store, rateSalt: 'archive-test-only'.repeat(3) });
  const owner = privateKeyToAccount(generatePrivateKey());
  const challenge = await app.identity.challenge({ address: owner.address });
  const login = await app.identity.session({ challengeId: challenge.id, signature: await owner.signMessage({ message: challenge.message }) });
  const actor = await app.identity.authenticate(login.token);
  const project = await app.identity.createProject(actor, { slug: 'portable', name: 'Portable', idempotencyKey: 'first' });
  const keys = generateKeyPairSync('ed25519'), operatorId = 'https://operator.example';
  const archives = createProjectArchives({ store, identity: app.identity, operatorId, signingKey: keys.privateKey });
  const trust = { trustedOperators: { [operatorId]: { [archiveKeyId(keys.publicKey)]: keys.publicKey } },
    expectedOwner: { address: owner.address, chainId: 1 } };
  return { store, app, actor, project, archives, trust, keys, operatorId, token: login.token };
}

test('signed archive retains every source version and artifact, excludes secrets and other projects', async t => {
  const f = await fixture(t), projectId = f.project.id;
  const snapshots = [];
  for (const content of ['version one', 'version two']) snapshots.push(await f.app.projects.createSnapshot(f.actor, projectId,
    { expectedProjectRevision: 1, files: [{ path: 'README.md', content }] }));
  const other = await f.app.identity.createProject(f.actor, { slug: 'private-other', name: 'Other', idempotencyKey: 'second' });
  await f.app.projects.createSnapshot(f.actor, other.id, { expectedProjectRevision: 1, files: [{ path: 'README.md', content: 'FOREIGN_CONTENT' }] });
  let artifactHash;
  await f.store.transaction(async tx => {
    artifactHash = await f.app.artifacts.put(tx, projectId, { report: 'review'.repeat(9000) });
    await tx.write('workflow-jobs', 'pending-job', { id: 'pending-job', projectId, kind: 'review-execute',
      state: 'waiting', effect: 'outcome_unknown', effectKey: 'original-paid-id', authority: { actor: 'SECRET_AUTHORITY' },
      lease: { token: 'SECRET_LEASE' }, result: null }, 0);
    await tx.write('review-quotes', 'quote', { id: 'quote', projectId, offer: { id: 'offer' } }, 0);
    await tx.write('imd-payments', 'offer', { id: 'offer', offerId: 'offer', state: 'outcome_unknown',
      payer: 'original-payer', amount: '500', sealedMaterial: 'SECRET_SIGNATURE' }, 0);
    await tx.write('chain-transactions', 'tx', { id: 'tx', intentHash: digest('intent'),
      intent: { authority: { projectId } }, state: 'unknown', hash: 'original-hash', sealedRaw: 'SECRET_RAW' }, 0);
    await tx.event({ type: 'credential.issued', projectId, credentialId: 'SECRET_CREDENTIAL', at: Date.now() });
  });
  const archive = await f.archives.export(f.actor, projectId), raw = JSON.stringify(archive);
  for (const forbidden of ['SECRET_AUTHORITY', 'SECRET_LEASE', 'SECRET_SIGNATURE', 'SECRET_RAW', 'SECRET_CREDENTIAL', 'FOREIGN_CONTENT', f.token])
    assert.ok(!raw.includes(forbidden));
  const verified = verifyProjectArchive(archive, f.trust);
  assert.equal(verified.authority, 'historical-only');
  assert.deepEqual(verified.records.filter(r => r.collection === 'snapshots').map(r => r.value.id).sort(), snapshots.map(s => s.id).sort());
  const manifest = verified.records.find(r => r.collection === 'artifact-manifests' && r.value.hash === artifactHash).value;
  const chunks = new Map(verified.records.filter(r => r.collection === 'artifact-chunks').map(r => [r.id, r.value.data]));
  const restored = JSON.parse(Buffer.concat(manifest.chunks.map(id => Buffer.from(chunks.get(id), 'base64'))).toString());
  assert.equal(digest(restored), artifactHash);
  assert.equal(verified.manifest.pendingEffects[0].effectKey, 'original-paid-id');
  assert.match(verified.manifest.pendingEffects[0].disposition, /never re-purchase/);
  assert.equal(verified.records.find(r => r.collection === 'imd-payments').value.payer, 'original-payer');
  assert.equal(verified.records.find(r => r.collection === 'chain-transactions').value.hash, 'original-hash');
});
test('altered pages, missing pages, forged key and changed owner are rejected', async t => {
  const f = await fixture(t), archive = await f.archives.export(f.actor, f.project.id);
  const altered = structuredClone(archive); altered.pages[0][0].value.name = 'changed';
  assert.throws(() => verifyProjectArchive(altered, f.trust), { code: 'archive_page_corrupt' });
  const missing = structuredClone(archive); missing.pages.pop();
  assert.throws(() => verifyProjectArchive(missing, f.trust), { code: 'archive_pages_mismatch' });
  const forged = structuredClone(archive); forged.manifest.owner.address = '0x' + '0'.repeat(40);
  assert.throws(() => verifyProjectArchive(forged, f.trust), { code: 'invalid_archive_signature' });
  assert.throws(() => verifyProjectArchive(archive, { ...f.trust, expectedOwner: { address: '0x' + '1'.repeat(40), chainId: 1 } }),
    { code: 'archive_owner_mismatch' });
  assert.throws(() => verifyProjectArchive(archive, { ...f.trust, trustedOperators: {} }), { code: 'untrusted_archive_operator' });
  const badKey = generateKeyPairSync('ed25519').publicKey;
  assert.throws(() => verifyProjectArchive(archive, { ...f.trust, trustedOperators: { [f.operatorId]: { [archiveKeyId(f.keys.publicKey)]: badKey } } }),
    { code: 'archive_key_mismatch' });
});

test('export mandate revocation is checked in the same transaction as the snapshot', async t => {
  const f = await fixture(t), agent = await f.app.identity.createAgent(f.actor, f.project.id, { name: 'Exporter' });
  const grant = await f.app.identity.grant(f.actor, f.project.id, { principalId: agent.id,
    scopes: ['project.export'], expiresAt: Date.now() + 3600000 });
  const credential = await f.app.identity.issueCredential(f.actor, { mandateId: grant.id });
  const actor = await f.app.identity.authenticate(credential.token);
  assert.equal((await f.archives.export(actor, f.project.id)).manifest.projectId, f.project.id);
  await f.app.identity.revoke(f.actor, 'mandate', grant.id);
  await assert.rejects(f.archives.export(actor, f.project.id), { code: 'scope_denied' });
});

test('retained historical verification keys allow rotation without trusting keys inside archives', async t => {
  const f = await fixture(t), old = await f.archives.export(f.actor, f.project.id), next = generateKeyPairSync('ed25519');
  const rotated = createProjectArchives({ store: f.store, identity: f.app.identity, operatorId: f.operatorId, signingKey: next.privateKey });
  const current = await rotated.export(f.actor, f.project.id);
  f.trust.trustedOperators[f.operatorId][archiveKeyId(next.publicKey)] = next.publicKey;
  assert.equal(verifyProjectArchive(old, f.trust).id, old.id);
  assert.equal(verifyProjectArchive(current, f.trust).id, current.id);
});

test('inference export retains outcomes without carrying provider accounts or allowances', async t => {
  const f = await fixture(t), projectId = f.project.id, hash = digest({ fixture: 'profile' });
  await f.store.transaction(async tx => {
    await tx.write('inference-requests', 'request', { id: 'request', projectId, requestHash: hash, profileHash: hash,
      work: 'outcome_unknown', billing: 'pending', actual: null, providerRequestId: 'original-provider-id',
      profile: { accountId: 'PRIVATE_PROVIDER_ACCOUNT' }, quote: { authorization: 'PRIVATE_QUOTE_AUTHORITY' } }, 0);
    await tx.write('inference-allowances', 'grant', { projectId, limit: 'PRIVATE_ALLOWANCE' }, 0);
    await tx.write('workflow-jobs', 'inference-job', { id: 'inference-job', projectId, kind: 'inference-execute',
      state: 'waiting', effect: 'outcome_unknown', effectKey: 'one-original-effect' }, 0);
    const project = await tx.read('projects', projectId);
    await tx.write('projects', projectId, { ...project.value, transfer: { destination: 'https://destination.example' } }, project.revision);
  });
  const archive = await f.archives.export(f.actor, projectId), raw = JSON.stringify(archive);
  for (const value of ['PRIVATE_PROVIDER_ACCOUNT', 'PRIVATE_QUOTE_AUTHORITY', 'PRIVATE_ALLOWANCE']) assert.equal(raw.includes(value), false);
  const checked = verifyProjectArchive(archive, f.trust);
  assert.equal(checked.records.find(r => r.collection === 'inference-requests').value.providerRequestId, 'original-provider-id');
  assert.match(checked.manifest.pendingEffects[0].disposition, /retain-at-source/);
  assert.equal(await f.app.identity.allowed(f.actor, 'inference.read', { projectId }), true);
  assert.equal(await f.app.identity.allowed(f.actor, 'inference.submit', { projectId }), false);
});
