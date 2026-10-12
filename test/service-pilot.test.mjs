import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createClient } from '../interfaces/sdk.mjs';
import { openStore } from '../src/storage/index.mjs';
import { createApplication, listen } from '../runtime/server.mjs';
import { ACCESS_DEFAULTS } from '../src/access/index.mjs';
import { createServiceConformance } from '../runtime/service-conformance.mjs';

test('public API/MCP service flow separates sponsorship, survives restart and preserves isolation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claus-service-pilot-'));
  let store, app, apiOrigin;
  const reopen = async () => {
    await store?.close();
    store = openStore(join(dir, 'state.sqlite'));
    app = createApplication({ store, origin: apiOrigin, rateSalt: 'service-pilot-local-fixture-salt-32' });
  };
  await reopen();
  const server = await listen({ fetch: (request, context) => app.fetch(request, context) });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await store.close(); await rm(dir, { recursive: true, force: true });
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  apiOrigin = origin; await reopen();
  const guest = createClient({ origin });
  async function participant(slug, scopes) {
    const account = privateKeyToAccount(generatePrivateKey());
    const challenge = await guest.call('auth_challenge', { address: account.address });
    const session = await guest.call('auth_session', { challengeId: challenge.id,
      signature: await account.signMessage({ message: challenge.message }) });
    const owner = createClient({ origin, token: session.token });
    const project = await owner.call('project_create', { slug, name: slug, idempotencyKey: slug });
    const agent = await owner.call('agent_create', { projectId: project.id, name: slug + ' agent' });
    const mandate = await owner.call('mandate_create', { projectId: project.id, principalId: agent.id,
      scopes, expiresAt: Date.now() + 3600000 });
    const credential = await owner.call('credential_create', { mandateId: mandate.id });
    return { owner, agent, projectId: project.id, address: account.address, mandate,
      call: async (name, args = {}) => {
        const response = await fetch(origin + '/mcp', { method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2025-06-18', authorization: 'Bearer ' + credential.token },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
            name, arguments: { projectId: project.id, ...args } } }) });
        assert.equal(response.status, 200);
        const { result } = await response.json();
        if (result.isError) { const failure = JSON.parse(result.content[0].text); throw Object.assign(Error(failure.error), { code: failure.error }); }
        return result.structuredContent;
      } };
  }
  const provider = await participant('pilot-provider', ['project.read', 'service.manage', 'service.read', 'service.provide', 'project.publish']);
  const buyer = await participant('pilot-buyer', ['project.read', 'service.call', 'service.read']);
  await store.transaction(tx => tx.write('network-capabilities', 'collaboration', { enabled: true }, 0));
  const schema = { type: 'object', properties: { value: { type: 'string', maxLength: 80 } }, required: ['value'], additionalProperties: false };
  const manifest = { name: 'Local pilot service', capability: 'pilot.echo', version: '1.0.0',
    inputSchema: schema, outputSchema: schema, priceWei: '0', recipient: provider.address,
    maxDurationSeconds: 600, validUntil: Date.now() + 86400000, dataPolicy: 'no-delegation' };
  await assert.rejects(provider.call('service_register', { manifest }), { code: 'sponsor_not_enabled' });
  await store.transaction(tx => tx.write('network', 'authority', { ownerAddress: provider.address.toLowerCase() }, 0));
  await assert.rejects(buyer.owner.call('access_policy_publish', { version: 'public-v1', config: { ...ACCESS_DEFAULTS, publicCollaboration: true } }), { code: 'scope_denied' });
  await provider.owner.call('access_policy_publish', { version: 'public-v1', config: { ...ACCESS_DEFAULTS, publicCollaboration: true } });
  await provider.owner.call('access_policy_activate', { version: 'public-v1', expectedGeneration: 0 });
  await assert.rejects(provider.owner.call('access_policy_activate', { version: 'public-v1', expectedGeneration: 0 }), { code: 'revision_conflict' });
  assert.equal((await guest.call('capabilities')).collaboration.admission, 'public');
  assert.equal((await provider.call('project_capabilities')).reviews.eligible, false);
  assert.equal((await store.list('review-pilots')).length, 0);
  await assert.rejects(provider.owner.call('wallet_create', { projectId: provider.projectId }), { code: 'wallets_not_enabled' });
  const publisher = await participant('public-publisher', ['project.read', 'snapshot.create', 'artifact.read', 'resource.read', 'release.publish', 'project.publish', 'project.export']);
  const snap = await publisher.call('snapshot_create', { files: [
    { path: 'index.html', content: '<h1>Reference result</h1>' },
    { path: 'src/main.ts', content: 'export const answer: number = 42' },
    { path: '.env.example', content: 'KEY=replace-locally' }
  ], expectedProjectRevision: 1 });
  const release = await publisher.call('release_create', { snapshotId: snap.id, paths: ['index.html'] });
  await publisher.call('release_publish', { releaseId: release.id, published: true, expiresAt: Date.now() + 3600000, expectedRevision: 0 });
  const accessList = await publisher.owner.call('identity_list', { projectId: publisher.projectId, kind: 'agents', limit: 1 });
  assert.equal(accessList.items[0].id, publisher.agent.id);
  assert.equal(accessList.items[0].projectId, publisher.projectId);
  assert(!JSON.stringify(accessList).includes(provider.agent.id));
  const resources = await publisher.call('resource_list', { kind: 'snapshots' });
  assert.deepEqual(resources.items.map(item => item.id), [snap.id]);
  await assert.rejects(buyer.owner.call('resource_list', { projectId: publisher.projectId, kind: 'snapshots' }), { code: 'scope_denied' });
  const agentArgs = { projectId: publisher.projectId, name: 'recoverable', idempotencyKey: 'recover-agent' };
  const extraAgent = await publisher.owner.call('agent_create', agentArgs);
  assert.deepEqual(await publisher.owner.call('agent_create', agentArgs), extraAgent);
  const grantArgs = { projectId: publisher.projectId, principalId: extraAgent.id, scopes: ['project.read'], expiresAt: Date.now() + 3600000, idempotencyKey: 'recover-grant' };
  const extraGrant = await publisher.owner.call('mandate_create', grantArgs);
  assert.deepEqual(await publisher.owner.call('mandate_create', grantArgs), extraGrant);
  await publisher.owner.call('mandate_revoke', { mandateId: extraGrant.id });
  assert((await publisher.owner.call('mandate_create', grantArgs)).revokedAt);
  const service = await provider.call('service_register', { manifest });
  assert.deepEqual((await provider.call('service_get', { serviceId: service.id })).publication,
    { published: false, revision: 0 });
  const conformance = () => createServiceConformance({ store, services: app.services }).tick();
  await conformance();
  const probe = (await provider.call('provider_orders')).orders.find(order => order.purpose === 'conformance');
  assert(probe);
  const probeClaim = await provider.call('provider_claim', { orderId: probe.id });
  await provider.call('provider_deliver', { orderId: probe.id, lease: probeClaim.lease, output: probeClaim.input });
  await conformance();
  assert.equal((await provider.call('service_get', { serviceId: service.id })).state, 'available');
  await provider.call('service_publish', { serviceId: service.id, published: true, expectedRevision: 0 });
  const quoteArgs = { serviceId: service.id, input: { value: 'consumer request' }, idempotencyKey: 'one-order' };
  const quote = await buyer.call('service_quote', quoteArgs);
  assert.equal(quote.maximumWei, '0');
  const order = await buyer.call('service_accept', { quoteId: quote.id });
  assert.equal(order.payment.state, 'not_required');
  assert.notEqual(order.id, probe.id);
  await reopen();
  assert.equal((await buyer.call('service_quote', quoteArgs)).id, quote.id);
  assert.equal((await buyer.call('service_accept', { quoteId: quote.id })).id, order.id);
  const claim = await provider.call('provider_claim', { orderId: order.id });
  assert.deepEqual(claim.input, quoteArgs.input);
  const delivered = await provider.call('provider_deliver', { orderId: order.id, lease: claim.lease,
    output: { value: 'consumer result' } });
  assert.deepEqual(await buyer.call('service_result', { orderId: order.id }), { value: 'consumer result' });
  assert.equal((await buyer.call('service_accept_result', { orderId: order.id,
    outputHash: delivered.outputHash, accepted: true })).acceptance, 'accepted');
  const current = await provider.call('service_get', { serviceId: service.id });
  assert.deepEqual(current.publication, { published: true, revision: 1 });
  await provider.call('service_publish', { serviceId: service.id, published: false, expectedRevision: current.publication.revision });
  await assert.rejects(provider.call('service_publish', { serviceId: service.id, published: true, expectedRevision: current.publication.revision }),
    { code: 'revision_conflict' });
  assert.equal((await guest.call('service_catalog')).services.length, 0);
  assert.deepEqual((await provider.call('service_get', { serviceId: service.id })).publication, { published: false, revision: 2 });
  await assert.rejects(buyer.call('service_get', { serviceId: service.id }), { code: 'not_found' });
  await provider.owner.call('project_access_set', { projectId: publisher.projectId, suspended: true, expectedRevision: 0 });
  await assert.rejects(publisher.call('snapshot_create', { files: [{ path: 'test.py', content: 'print(42)' }], expectedProjectRevision: 1 }), { code: 'scope_denied' });
  assert.equal((await publisher.call('project_export', { snapshotId: snap.id })).files.length, 3);
  await publisher.call('release_publish', { releaseId: release.id, published: false, expiresAt: Date.now() + 3600000, expectedRevision: 1 });
  await assert.rejects(guest.call('public_release', { releaseId: release.id }), { code: 'not_found' });
  await provider.owner.call('mandate_revoke', { mandateId: provider.mandate.id });
  await assert.rejects(provider.call('service_get', { serviceId: service.id }), { code: 'scope_denied' });
  // Run the shipped example unchanged, then reopen it in a fresh client process.
  let ticking = false;
  const timer = setInterval(async () => {
    if (ticking) return; ticking = true;
    try { await conformance(); } finally { ticking = false; }
  }, 100);
  try {
    const example = new URL('../reference/public-project.mjs', import.meta.url).pathname;
    const options = { env: { ...process.env, CLAUS_NETWORK_URL: origin }, timeout: 30000 };
    const first = await promisify(execFile)(process.execPath, [example, join(dir, 'example')], options);
    assert(first.stdout.includes('"state":"complete"'));
    const second = await promisify(execFile)(process.execPath, [example, join(dir, 'example'), 'verify'], options);
    assert(second.stdout.includes('"state":"restart_verified"'));
  } finally { clearInterval(timer); }
  for (const collection of ['review-cases', 'chain-transactions', 'wallet-actions'])
    assert.equal((await store.list(collection)).length, 0, collection + ' must remain unused');
});
