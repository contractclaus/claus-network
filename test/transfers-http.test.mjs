import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { openStore } from '../src/storage/index.mjs';
import { createApplication, listen } from '../runtime/server.mjs';
import { archiveKeyId } from '../src/portability/index.mjs';
import { createClient } from '../interfaces/sdk.mjs';

test('SDK moves a project through paged HTTP, then continues while the source server is stopped', async t => {
  const keys = generateKeyPairSync('ed25519'), account = privateKeyToAccount(generatePrivateKey());
  const sourceId = 'https://source.example', destinationId = 'https://destination.example';
  const source = openStore(':memory:'), destination = openStore(':memory:');
  const a = createApplication({ store: source, rateSalt: 'source-http-fixture'.repeat(2),
    operatorPorts: { operatorId: sourceId, signingKey: keys.privateKey } });
  const b = createApplication({ store: destination, rateSalt: 'destination-http-fixture'.repeat(2),
    operatorPorts: { operatorId: destinationId,
      trustedOperators: { [sourceId]: { [archiveKeyId(keys.publicKey)]: keys.publicKey } } } });
  const sa = await listen(a), sb = await listen(b);
  const sourceUrl = 'http://127.0.0.1:' + sa.address().port, destinationUrl = 'http://127.0.0.1:' + sb.address().port;
  let sourceClosed = false;
  t.after(async () => { if (!sourceClosed) await new Promise(r => sa.close(r)); await new Promise(r => sb.close(r)); source.close(); destination.close(); });
  async function connect(origin) {
    const guest = createClient({ origin }), challenge = await guest.call('auth_challenge', { address: account.address });
    const login = await guest.call('auth_session', { challengeId: challenge.id, signature: await account.signMessage({ message: challenge.message }) });
    return { client: createClient({ origin, token: login.token }), token: login.token };
  }
  const ca = await connect(sourceUrl), cb = await connect(destinationUrl);
  const project = await ca.client.call('project_create', { slug: 'transfer-http', name: 'HTTP transfer fixture', idempotencyKey: 'fixture' });
  const snapshot = await ca.client.call('snapshot_create', { projectId: project.id, expectedProjectRevision: 1,
    files: [{ path: 'README.md', content: 'Preserved through the HTTP protocol' }] });
  const request = { projectId: project.id, expectedProjectRevision: 1, destination: destinationId, idempotencyKey: 'transfer' };
  await assert.rejects(ca.client.call('project_transfer_prepare', request), { code: 'portability_not_enabled' });
  assert.equal((await ca.client.call('project_get', { projectId: project.id })).transfer, undefined);
  await source.transaction(async tx => {
    await tx.write('network-capabilities', 'portability', { enabled: true }, 0);
    await tx.write('network-capabilities', 'collaboration', { enabled: true }, 0);
    await tx.write('review-pilots', project.id, { enabled: true, expiresAt: Date.now() + 60000 }, 0);
  });
  const header = await ca.client.call('project_transfer_prepare', request);
  await assert.rejects(cb.client.call('project_import_begin', { header }), { code: 'portability_not_enabled' });
  await destination.transaction(tx => tx.write('network-capabilities', 'portability', { enabled: true }, 0));
  await cb.client.call('project_import_begin', { header });
  for (let page = 0; page < header.manifest.pages.length; page++) {
    const records = await ca.client.call('project_transfer_page', { projectId: project.id, archiveId: header.id, page });
    await cb.client.call('project_import_page', { archiveId: header.id, page, records });
  }
  const badPage = await fetch(sourceUrl + '/v1/projects/' + project.id + '/transfers/' + encodeURIComponent(header.id) + '/pages/0x0',
    { headers: { authorization: 'Bearer ' + ca.token } });
  assert.equal(badPage.status, 400);
  await new Promise(r => sa.close(r)); sourceClosed = true;
  const moved = await cb.client.call('project_import_commit', { archiveId: header.id });
  assert.equal(moved.id, project.id);
  assert.equal((await cb.client.call('snapshot_get', { projectId: project.id, snapshotId: snapshot.id })).id, snapshot.id);
  const continued = await cb.client.call('snapshot_create', { projectId: project.id, expectedProjectRevision: 1,
    files: [{ path: 'README.md', content: 'Continued without source coordinator or website' }] });
  assert.notEqual(continued.id, snapshot.id);
  const history = await cb.client.call('project_import_history', { projectId: project.id });
  assert.equal(history.id, header.id);
});
