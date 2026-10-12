import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createApplication } from '../runtime/server.mjs';
import { openStore } from '../src/storage/index.mjs';
import { digest } from '../src/shared/index.mjs';

async function fixture(t) {
  const store = openStore(':memory:'); t.after(() => store.close()); let time = Date.now();
  const app = createApplication({ store, now: () => time, rateSalt: 'test-only'.repeat(6),
    chainPorts: { vault: { transaction: async (_, input) => ({ ...input, fixture: true }) } } });
  async function project(slug) {
    const key = privateKeyToAccount(generatePrivateKey()), challenge = await app.identity.challenge({ address: key.address });
    const login = await app.identity.session({ challengeId: challenge.id, signature: await key.signMessage({ message: challenge.message }) });
    const owner = await app.identity.authenticate(login.token);
    const p = await app.identity.createProject(owner, { slug, name: slug, idempotencyKey: slug });
    const agent = await app.identity.createAgent(owner, p.id, { name: 'test agent' });
    const mandate = await app.identity.grant(owner, p.id, { principalId: agent.id,
      scopes: ['vault.read', 'vault.manage', 'job.cancel'], expiresAt: time + 86400000 });
    const credential = await app.identity.issueCredential(owner, { mandateId: mandate.id });
    return { id: p.id, owner, actor: await app.identity.authenticate(credential.token), mandate };
  }
  const p = await project('vault-one'), other = await project('vault-other');
  const cap = { enabled: true, chainId: 11155111, artifactProjectId: p.id,
    artifactHash: digest('vault fixture'), reviewArtifactHash: digest('review fixture') };
  const policy = { chainId: 11155111, profile: 'claus-readonly-v1', target: '0x' + '11'.repeat(20),
    verification: { state: 'verified', localFixture: true } };
  cap.policies = { [p.id]: { bindingHash: digest(policy), implementation: '0x' + '22'.repeat(20),
    implementationCodeHash: '0x' + '33'.repeat(32), configurationBytes: 64 } };
  async function enable() { await store.transaction(async tx => {
    await tx.write('network-capabilities', 'vaults', cap, 0);
    await tx.write('review-pilots', p.id, { enabled: true, expiresAt: time + 86400000 }, 0);
    await tx.write('chain-bindings', p.id, policy, 0);
  }); }
  return { store, app, p, other, cap, enable, advance: ms => time += ms };
}

test('vault creation requires explicit enablement, a verified policy and project authority; concurrent requests share one job', async t => {
  const f = await fixture(t);
  await assert.rejects(f.app.vaults.create(f.p.actor, f.p.id), { code: 'vaults_not_enabled' });
  await f.enable();
  await assert.rejects(f.app.vaults.create(f.other.actor, f.p.id), { code: 'scope_denied' });
  const [a, b] = await Promise.all([f.app.vaults.create(f.p.actor, f.p.id), f.app.vaults.create(f.p.actor, f.p.id)]);
  assert.equal(a.id, b.id); assert.equal((await f.store.list('workflow-jobs')).length, 1);
  await f.app.jobs.cancel(f.p.actor, f.p.id, a.jobId);
  const c = await f.app.vaults.create(f.p.actor, f.p.id); assert.notEqual(c.id, a.id); assert.equal(c.attempt, 2);
  await f.app.identity.revoke(f.p.owner, 'mandate', f.p.mandate.id);
  const result = await f.app.vaults.runOne({ step: async () => assert.fail('revoked work must not reach a signer') });
  assert.equal(result.state, 'blocked');
  assert.equal((await f.app.vaults.get(f.p.owner, f.p.id)).state, 'blocked');
});

test('uncertain deployment keeps its original identity and exits remain readable when new deployments stop', async t => {
  const f = await fixture(t); await f.enable();
  const first = await f.app.vaults.create(f.p.actor, f.p.id);
  await f.app.vaults.runOne({ step: async () => ({ state: 'submitted', transactionHash: '0x' + '12'.repeat(32) }) });
  assert.equal((await f.app.vaults.create(f.p.actor, f.p.id)).id, first.id);
  f.advance(31000);
  await f.app.vaults.runOne({ step: async ({ value }) => {
    assert.equal(value.id, first.id); return { state: 'verified', address: '0x' + '22'.repeat(20) };
  } });
  await f.store.transaction(async tx => {
    await tx.write('network-capabilities', 'vaults', { ...f.cap, enabled: false }, 1);
    await tx.write('review-pilots', f.p.id, { enabled: false }, 1);
  });
  await assert.rejects(f.app.vaults.create(f.p.actor, f.p.id), { code: 'vaults_not_enabled' });
  const input = { kind: 'withdraw', amountWei: '1', recipient: '0x' + '33'.repeat(20) };
  assert.equal((await f.app.vaults.transaction(f.p.actor, f.p.id, input)).kind, 'withdraw');
  await assert.rejects(f.app.vaults.transaction(f.other.actor, f.p.id, input), { code: 'scope_denied' });
});

test('changing the pinned vault review before dispatch prevents deployment', async t => {
  const f = await fixture(t); await f.enable(); await f.app.vaults.create(f.p.actor, f.p.id);
  await f.store.transaction(tx => tx.write('network-capabilities', 'vaults', {
    ...f.cap, reviewArtifactHash: digest('different review') }, 1));
  const result = await f.app.vaults.runOne({ step: async () => assert.fail('changed profile must not reach a signer') });
  assert.equal(result.state, 'blocked');
});

test('review sponsorship alone cannot admit an unapproved vault policy', async t => {
  const f = await fixture(t); await f.enable();
  await f.store.transaction(tx => tx.write('network-capabilities', 'vaults', { ...f.cap, policies: {} }, 1));
  await assert.rejects(f.app.vaults.create(f.p.actor, f.p.id), { code: 'policy_not_verified' });
  assert.equal((await f.store.list('workflow-jobs')).length, 0);
});

test('withdrawing a policy admission before dispatch prevents deployment', async t => {
  const f = await fixture(t); await f.enable(); await f.app.vaults.create(f.p.actor, f.p.id);
  await f.store.transaction(tx => tx.write('network-capabilities', 'vaults', { ...f.cap, policies: {} }, 1));
  const result = await f.app.vaults.runOne({ step: async () => assert.fail('withdrawn policy must not reach a signer') });
  assert.equal(result.state, 'blocked');
});
