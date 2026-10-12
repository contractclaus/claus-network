import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { openStore } from '../src/storage/index.mjs';
import { createApplication, listen } from '../runtime/server.mjs';
import { createClient } from '../interfaces/sdk.mjs';

async function fixture(t, enabled = true) {
  const store = openStore(':memory:');
  const app = createApplication({ store, rateSalt: 'contract-intake-test-salt-12345678', intakePorts: enabled ? {
    enabled: true, chain: { profile: async () => ({ chainId: 11155111, inbox: '0x' + '11'.repeat(20),
      codeHash: '0x' + '22'.repeat(32), capability: '0x' + '33'.repeat(32) }) }
  } : {} });
  const server = await listen(app), origin = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await store.close(); });
  const account = privateKeyToAccount(generatePrivateKey()), anonymous = createClient({ origin });
  const challenge = await anonymous.call('auth_challenge', { address: account.address });
  const session = await anonymous.call('auth_session', { challengeId: challenge.id,
    signature: await account.signMessage({ message: challenge.message }) });
  const owner = createClient({ origin, token: session.token });
  const project = await owner.call('project_create', { slug: 'contract-test', name: 'Contract intake test', idempotencyKey: 'first' });
  await store.transaction(tx => tx.write('network-capabilities', 'contract-intake', { enabled: true }, 0));
  return { store, app, owner, project, origin };
}

test('SDK and MCP expose the same scoped binding lifecycle without a website', async t => {
  const f = await fixture(t);
  const agent = await f.owner.call('agent_create', { projectId: f.project.id, name: 'Contract requester' });
  const mandate = await f.owner.call('mandate_create', { projectId: f.project.id, principalId: agent.id,
    scopes: ['contract.read', 'contract.request', 'proposal.create'], expiresAt: Date.now() + 3600000 });
  const credential = await f.owner.call('credential_create', { mandateId: mandate.id });
  const client = createClient({ origin: f.origin, token: credential.token });
  const bound = await client.call('contract_binding_create', { projectId: f.project.id, requester: '0x' + '44'.repeat(20),
    expiresAt: Date.now() + 1800000, maxRequests: 2, idempotencyKey: 'only-two' });
  assert.equal(bound.actor, undefined);
  assert.match(bound.onchainBinding, /^0x[0-9a-f]{64}$/);
  assert.equal((await client.call('contract_binding_get', { projectId: f.project.id, bindingId: bound.id })).used, 0);
  const result = await fetch(f.origin + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json',
    accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18',
    authorization: 'Bearer ' + credential.token }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  const tools = await result.json();
  assert.ok(tools.result.tools.some(x => x.name === 'contract_binding_create'));
  await client.call('contract_binding_revoke', { projectId: f.project.id, bindingId: bound.id });
  assert.ok((await client.call('contract_binding_get', { projectId: f.project.id, bindingId: bound.id })).revokedAt);
  await f.owner.call('mandate_revoke', { mandateId: mandate.id });
  await assert.rejects(client.call('contract_binding_get', { projectId: f.project.id, bindingId: bound.id }), { code: 'scope_denied' });
});

test('a database flag cannot enable an absent contract adapter', async t => {
  const f = await fixture(t, false);
  await assert.rejects(f.owner.call('contract_binding_create', { projectId: f.project.id,
    requester: '0x' + '44'.repeat(20), expiresAt: Date.now() + 1800000, maxRequests: 1, idempotencyKey: 'disabled' }),
  { code: 'contract_intake_disabled', status: 409 });
  assert.equal((await f.store.list('contract-bindings')).length, 0);
});
