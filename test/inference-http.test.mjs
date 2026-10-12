import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { openStore } from '../src/storage/index.mjs';
import { createApplication, listen } from '../runtime/server.mjs';
import { createClient } from '../interfaces/sdk.mjs';
import { createBilling, balance } from '../src/billing/index.mjs';
import { digest } from '../src/shared/index.mjs';

async function fixture(t, runtimeEnabled = true) {
  const store = openStore(':memory:'); const proof = digest({ fixture: 'no-real-provider' });
  let calls = 0, time = Date.now();
  const provider = {
    async quote(p) { return { id: digest({ quote: p.requestHash }), requestHash: p.requestHash, profileHash: digest(p.profile),
      providerId: p.profile.providerId, accountId: p.profile.accountId, asset: p.profile.asset,
      maximum: '200', expiresAt: time + 300000, proofHash: proof }; },
    async dispatch(p) { calls++; return null; },
    async reconcile(p) { return { work: 'failed', providerRequestId: p.requestId, receipt: {
      effectKey: p.effectKey, requestHash: p.requestHash, profileHash: p.quote.profileHash,
      quoteId: p.quote.id, providerId: p.profile.providerId, accountId: p.profile.accountId,
      providerRequestId: p.requestId, asset: p.profile.asset, actual: '0', final: true, proofHash: proof } }; }
  };
  const app = createApplication({ store, rateSalt: 'test-only-ratelimit-salt-0123456789', now: () => time,
    inferencePorts: runtimeEnabled ? { enabled: true, provider, verifyQuote: async () => true, verifyReceipt: async () => true } : {} });
  const server = await listen(app), origin = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await store.close(); });
  async function login() {
    const account = privateKeyToAccount(generatePrivateKey()), client = createClient({ origin });
    const challenge = await client.call('auth_challenge', { address: account.address });
    const session = await client.call('auth_session', { challengeId: challenge.id, signature: await account.signMessage({ message: challenge.message }) });
    return { account, client: createClient({ origin, token: session.token }) };
  }
  const owner = await login(), stranger = await login();
  const project = await owner.client.call('project_create', { slug: 'inference-fixture', name: 'Inference test', idempotencyKey: 'one' });
  await store.transaction(tx => tx.write('network', 'authority', { ownerAddress: owner.account.address.toLowerCase() }, 0));
  const profile = { id: 'text-v1', version: 'v1', enabled: true, providerId: 'test-provider', accountId: 'test-org',
    model: 'test-model', providers: ['test-upstream'], asset: 'test-only-credit', fundingAccount: 'test-funded',
    permissionHash: proof, dataPolicyHash: proof, expiresAt: time + 86400000, maximumPerRequest: '200', maxInputBytes: 8000, maxOutputTokens: 1024 };
  return { store, app, origin, owner, stranger, project, profile, calls: () => calls, advance: () => { time += 60001; },
    async configure() {
      await owner.client.call('inference_profile_set', { profile, expectedRevision: 0 });
      await owner.client.call('inference_allowance_set', { projectId: project.id, profileId: profile.id,
        enabled: true, expiresAt: profile.expiresAt, limit: '400', expectedRevision: 0 });
      await store.transaction(tx => tx.write('network-capabilities', 'inference', { enabled: true }, 0));
    }
  };
}

test('HTTP/SDK inference keeps operator configuration separate from delegated usage and actual funding', async t => {
  const f = await fixture(t), { client } = f.owner;
  await assert.rejects(f.stranger.client.call('inference_profile_set', { profile: f.profile, expectedRevision: 0 }), { code: 'scope_denied' });
  await f.configure();
  await assert.rejects(client.call('inference_profile_set', { profile: { ...f.profile, accountId: 'changed-account' }, expectedRevision: 1 }), { code: 'inference_profile_immutable' });
  const agent = await client.call('agent_create', { projectId: f.project.id, name: 'Inference test agent' });
  const mandate = await client.call('mandate_create', { projectId: f.project.id, principalId: agent.id,
    scopes: ['inference.read', 'inference.submit', 'job.cancel'], expiresAt: f.profile.expiresAt });
  const credential = await client.call('credential_create', { mandateId: mandate.id });
  const agentClient = createClient({ origin: f.origin, token: credential.token });
  const profile = await agentClient.call('inference_profile', { projectId: f.project.id, profileId: f.profile.id });
  assert.equal(profile.accountId, undefined); assert.equal(profile.fundingAccount, undefined);
  assert.equal(profile.profileHash, digest(f.profile));
  const request = { projectId: f.project.id, profileId: f.profile.id, profileHash: profile.profileHash,
    model: profile.model, input: 'Private test question', maxOutputTokens: 256, idempotencyKey: 'one' };
  await assert.rejects(agentClient.call('inference_submit', request), { code: 'funding_insufficient' });
  assert.equal(f.calls(), 0);
  await createBilling({ store: f.store, authorize: () => true, now: () => Date.now() }).recordFunding({
    actor: 'fixture', account: f.profile.fundingAccount, asset: f.profile.asset, amount: '1000', receiptId: 'test-only-funding' });
  const accepted = await agentClient.call('inference_submit', request); await f.app.inference.run();
  assert.equal(f.calls(), 1);
  await assert.rejects(agentClient.call('inference_allowance_set', { projectId: f.project.id, profileId: f.profile.id,
    enabled: true, expiresAt: f.profile.expiresAt, limit: '9999', expectedRevision: 2 }), { code: 'scope_denied' });
  await assert.rejects(client.call('inference_allowance_set', { projectId: f.project.id, profileId: f.profile.id,
    enabled: false, expiresAt: f.profile.expiresAt, limit: '0', expectedRevision: 2 }), { code: 'inference_allowance_below_exposure' });
  await client.call('mandate_revoke', { mandateId: mandate.id });
  await assert.rejects(agentClient.call('inference_get', { projectId: f.project.id, requestId: accepted.id }), { code: 'scope_denied' });
  f.advance(); await f.app.inference.run();
  const settled = await client.call('inference_get', { projectId: f.project.id, requestId: accepted.id });
  assert.equal(settled.work, 'failed'); assert.equal(settled.cost.actual, '0');
  assert.equal((await balance(f.store, f.profile.fundingAccount, f.profile.asset)).available, '1000');
  assert.equal(f.calls(), 1);
  assert.equal((await client.call('network_graph')).nodes.length, 1);
});

test('an enabled database profile alone cannot turn on a production provider', async t => {
  const f = await fixture(t, false); await f.configure();
  const profile = await f.owner.client.call('inference_profile', { projectId: f.project.id, profileId: f.profile.id });
  assert.equal(profile.enabled, false);
  await assert.rejects(f.owner.client.call('inference_submit', { projectId: f.project.id, profileId: f.profile.id,
    profileHash: profile.profileHash, model: profile.model, input: 'Must remain private', maxOutputTokens: 32, idempotencyKey: 'disabled' }), { code: 'inference_disabled' });
  assert.equal(f.calls(), 0);
});
