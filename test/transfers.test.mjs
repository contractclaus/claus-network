import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { openStore } from '../src/storage/index.mjs';
import { createApplication } from '../runtime/server.mjs';
import { archiveKeyId, createProjectArchives } from '../src/portability/index.mjs';
import { createProjectTransfers } from '../src/transfers/index.mjs';
import { digest } from '../src/shared/index.mjs';

async function login(app, account) {
  const c = await app.identity.challenge({ address: account.address });
  const s = await app.identity.session({ challengeId: c.id, signature: await account.signMessage({ message: c.message }) });
  return app.identity.authenticate(s.token);
}
async function fixture(t) {
  const account = privateKeyToAccount(generatePrivateKey()), keys = generateKeyPairSync('ed25519');
  const source = openStore(':memory:'), destination = openStore(':memory:');
  let closed = false; t.after(() => { if (!closed) source.close(); destination.close(); });
  const a = createApplication({ store: source, rateSalt: 'source-local-fixture'.repeat(2) });
  const b = createApplication({ store: destination, rateSalt: 'destination-local-fixture'.repeat(2) });
  const actorA = await login(a, account), actorB = await login(b, account);
  const operatorA = 'https://source.example', operatorB = 'https://destination.example';
  const trustedOperators = { [operatorA]: { [archiveKeyId(keys.publicKey)]: keys.publicKey } };
  const archives = createProjectArchives({ store: source, identity: a.identity, operatorId: operatorA, signingKey: keys.privateKey });
  const transfersA = createProjectTransfers({ store: source, identity: a.identity, artifacts: a.artifacts, archives, operatorId: operatorA });
  const transfersB = createProjectTransfers({ store: destination, identity: b.identity, artifacts: b.artifacts,
    operatorId: operatorB, trustedOperators });
  const project = await a.identity.createProject(actorA, { slug: 'portable-project', name: 'Portable local fixture', idempotencyKey: 'local' });
  const version = await a.projects.createSnapshot(actorA, project.id, { expectedProjectRevision: 1,
    files: [{ path: 'README.md', content: 'Original private source' }] });
  const prepare = () => transfersA.prepare(actorA, project.id, { destination: operatorB, expectedProjectRevision: 1, idempotencyKey: 'move' });
  async function copy(header) {
    await transfersB.beginImport(actorB, header);
    for (let page = 0; page < header.manifest.pages.length; page++) {
      const records = await transfersA.page(actorA, project.id, { archiveId: header.id, page });
      await transfersB.receive(actorB, { archiveId: header.id, page, records });
    }
  }
  return { source, destination, a, b, actorA, actorB, account, transfersA, transfersB, project, version, prepare, copy,
    closeSource() { source.close(); closed = true; } };
}

test('fenced transfer resumes on a separate operator with the source offline and fresh authority', async t => {
  const f = await fixture(t), id = f.project.id;
  await f.source.transaction(async tx => {
    await tx.write('workflow-jobs', 'original-paid-job', { id: 'original-paid-job', projectId: id, kind: 'review-execute',
      state: 'waiting', effect: 'outcome_unknown', effectKey: 'original-provider-id', authority: { actor: 'private-source-authority' } }, 0);
    await tx.write('project-wallets', id, { projectId: id, state: 'verified', address: '0x' + '1'.repeat(40) }, 0);
  });
  const header = await f.prepare(); assert.equal(header.manifest.purpose, 'source-fenced-transfer');
  assert.deepEqual(await f.prepare(), header, 'lost response returns the same signed snapshot');
  await assert.rejects(f.a.projects.createSnapshot(f.actorA, id, { expectedProjectRevision: 2,
    files: [{ path: 'README.md', content: 'must not change' }] }), { code: 'scope_denied' });
  assert.equal(await f.a.identity.allowed(f.actorA, 'wallet.manage', { projectId: id }), false);
  assert.equal(await f.a.identity.allowed(f.actorA, 'wallet.revoke', { projectId: id }), true);
  assert.equal(await f.a.identity.allowed(f.actorA, 'vault.read', { projectId: id }), true);
  await f.copy(header); f.closeSource();
  const imported = await f.transfersB.commit(f.actorB, header.id);
  assert.equal(imported.id, id); assert.equal(imported.provenance.historyAuthority, 'historical-only');
  assert.deepEqual(await f.transfersB.commit(f.actorB, header.id), imported);
  const old = await f.b.projects.files(f.actorB, id, f.version.id);
  assert.equal(old[0].content, 'Original private source');
  assert.equal(await f.destination.read('workflow-jobs', 'original-paid-job'), null);
  assert.equal(await f.destination.read('project-wallets', id), null);
  const saved = await f.transfersB.history(f.actorB, id, {});
  assert.equal(saved.manifest.pendingEffects[0].effectKey, 'original-provider-id');
  const next = await f.b.projects.createSnapshot(f.actorB, id, { expectedProjectRevision: 1,
    files: [{ path: 'README.md', content: 'Continued with source operator offline' }] });
  assert.notEqual(next.id, f.version.id);
  const agent = await f.b.identity.createAgent(f.actorB, id, { name: 'New operator agent' });
  const mandate = await f.b.identity.grant(f.actorB, id, { principalId: agent.id, scopes: ['project.read'], expiresAt: Date.now() + 60000 });
  const key = await f.b.identity.issueCredential(f.actorB, { mandateId: mandate.id });
  const actor = await f.b.identity.authenticate(key.token);
  assert.equal((await f.b.identity.project(actor, id)).id, id);
  await f.b.identity.revoke(f.actorB, 'mandate', mandate.id);
  await assert.rejects(f.b.identity.project(actor, id), { code: 'scope_denied' });
});

test('wrong owner, modified attestation, missing pages and corrupted content cannot import', async t => {
  const f = await fixture(t), header = await f.prepare();
  const other = await login(f.b, privateKeyToAccount(generatePrivateKey()));
  await assert.rejects(f.transfersB.beginImport(other, header), { code: 'archive_owner_mismatch' });
  const forged = structuredClone(header); forged.manifest.transfer.destination = 'https://attacker.example';
  await assert.rejects(f.transfersB.beginImport(f.actorB, forged), { code: 'invalid_archive_signature' });
  await f.transfersB.beginImport(f.actorB, header);
  await assert.rejects(f.transfersB.commit(f.actorB, header.id), { code: 'archive_pages_missing' });
  const page = await f.transfersA.page(f.actorA, f.project.id, { archiveId: header.id, page: 0 });
  const corrupted = structuredClone(page); corrupted[0].originalHash = digest('wrong');
  await assert.rejects(f.transfersB.receive(f.actorB, { archiveId: header.id, page: 0, records: corrupted }), { code: 'archive_page_corrupt' });
  await f.copy(header);
  assert.equal((await f.transfersB.commit(f.actorB, header.id)).id, f.project.id);
});

test('a destination never overwrites an existing project or silently imports live authority', async t => {
  const f = await fixture(t), header = await f.prepare();
  await f.destination.transaction(tx => tx.write('projects', f.project.id, { ...f.project, name: 'Existing project' }, 0));
  await assert.rejects(f.transfersB.beginImport(f.actorB, header), { code: 'project_id_taken' });
  assert.equal((await f.destination.read('projects', f.project.id)).value.name, 'Existing project');
});

test('a second move retains the first operator signature and original history pages', async t => {
  const f = await fixture(t), first = await f.prepare();
  await f.copy(first); await f.transfersB.commit(f.actorB, first.id); f.closeSource();
  const keys = generateKeyPairSync('ed25519');
  const archives = createProjectArchives({ store: f.destination, identity: f.b.identity,
    operatorId: 'https://destination.example', signingKey: keys.privateKey });
  const second = await archives.export(f.actorB, f.project.id);
  const records = second.pages.flat();
  const history = records.find(r => r.collection === 'imported-history').value;
  assert.deepEqual(history.header, first);
  for (const hash of first.manifest.pages) {
    const manifest = records.find(r => r.collection === 'artifact-manifests' && r.value.hash === hash);
    assert.ok(manifest, 'original history page remains in the next archive');
    for (const id of manifest.value.chunks) assert.ok(records.some(r => r.collection === 'artifact-chunks' && r.id === id));
  }
});

test('a transferred project may withdraw its source publications but cannot publish new work', async t => {
  const f = await fixture(t), id = f.project.id;
  const publication = await f.a.projects.publish(f.actorA, id, { published: true, expectedRevision: 0 });
  const source = await f.a.projects.publishSource(f.actorA, id, { snapshotId: f.version.id, published: true, expectedRevision: 0 });
  await f.prepare();
  await assert.rejects(f.a.projects.publish(f.actorA, id, { published: true, expectedRevision: publication.revision }), { code: 'scope_denied' });
  await assert.rejects(f.a.projects.publishSource(f.actorA, id, { snapshotId: f.version.id, published: true, expectedRevision: source.revision }), { code: 'scope_denied' });
  await f.a.projects.publish(f.actorA, id, { published: false, expectedRevision: publication.revision });
  await f.a.projects.publishSource(f.actorA, id, { snapshotId: f.version.id, published: false, expectedRevision: source.revision });
  await assert.rejects(f.a.projects.publicProject(f.project.slug), { code: 'not_found' });
  await assert.rejects(f.a.projects.publicSource(source.id), { code: 'not_found' });
  const other = await login(f.a, privateKeyToAccount(generatePrivateKey()));
  assert.equal(await f.a.identity.allowed(other, 'project.publish', { projectId: id, withdrawal: true }), false);
  assert.equal(await f.a.identity.allowed(f.actorA, 'wallet.pay', { projectId: id, withdrawal: true }), false);
});
