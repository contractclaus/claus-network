import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/storage/index.mjs';
import { createBilling, balance } from '../src/billing/index.mjs';
import { createJobs } from '../src/jobs/index.mjs';
import { createArtifactStore } from '../src/artifact-store/index.mjs';
import { createInference } from '../src/inference/index.mjs';
import { digest, requireThat } from '../src/shared/index.mjs';
import { surplusTextRequest, surplusTextObservation } from '../adapters/surplus-text.mjs';

const quoteProof = digest({ fixture: 'bounded-quote' }), costProof = digest({ fixture: 'final-cost' });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'claus-inference-'));
  const f = { time: 1800000000000, enabled: true, revoked: false, calls: [], quotes: [],
    handler: async () => null, quoteTrusted: true, receiptTrusted: true };
  f.profile = { id: 'text-pilot', version: 'v1', enabled: true, providerId: 'surplus', accountId: 'test-org',
    model: 'test-model', providers: ['openai'], asset: 'test-provider-credit-micro-usd', fundingAccount: 'funded-test-account',
    permissionHash: digest({ fixture: 'permission' }), dataPolicyHash: digest({ fixture: 'data' }),
    expiresAt: f.time + 86400000, maximumPerRequest: '200', maxInputBytes: 8000, maxOutputTokens: 1024 };
  const identity = { async authorize(actor, action, { projectId }) {
    requireThat(actor === 'owner' || (actor === 'agent' && !f.revoked && projectId === 'project-a'), 'scope_denied');
  } };
  const provider = {
    async quote(p) {
      f.quotes.push(p);
      return { id: digest({ quote: p.requestHash }), providerId: p.profile.providerId, accountId: p.profile.accountId,
        asset: p.profile.asset, requestHash: p.requestHash, profileHash: digest(p.profile), maximum: '200',
        expiresAt: f.time + 300000, proofHash: quoteProof };
    },
    async dispatch(p) { f.calls.push({ mode: 'dispatch', ...p }); return f.handler(p, 'dispatch'); },
    async reconcile(p) { f.calls.push({ mode: 'reconcile', ...p }); return f.handler(p, 'reconcile'); }
  };
  f.open = () => {
    f.store = openStore(join(directory, 'state.sqlite'));
    f.jobs = createJobs({ store: f.store, identity, now: () => f.time, onCancel: (tx, job) => f.api.onCancel(tx, job) });
    f.api = createInference({ store: f.store, identity, jobs: f.jobs, artifacts: createArtifactStore({ store: f.store }),
      provider, now: () => f.time, enabled: () => f.enabled,
      verifyQuote: async q => f.quoteTrusted && q.proofHash === quoteProof,
      verifyReceipt: async r => f.receiptTrusted && r.proofHash === costProof });
  };
  f.open(); t.after(async () => { await f.store.close(); await rm(directory, { recursive: true, force: true }); });
  f.restart = async () => { await f.store.close(); f.open(); };
  const billing = createBilling({ store: f.store, authorize: () => true, now: () => f.time });
  await billing.recordFunding({ actor: 'fixture', account: f.profile.fundingAccount, asset: f.profile.asset, amount: '1000', receiptId: 'test-only-funding' });
  await f.store.transaction(async tx => {
    await tx.write('inference-profiles', f.profile.id, f.profile, 0);
    for (const projectId of ['project-a', 'project-b']) await tx.write('inference-allowances', digest({ projectId, profileId: f.profile.id }),
      { enabled: true, expiresAt: f.time + 86400000, limit: '400', reserved: '0', spent: '0' }, 0);
  });
  f.body = (key = 'one', changes = {}) => ({ profileId: f.profile.id, profileHash: digest(f.profile), model: f.profile.model, input: 'Private test input',
    maxOutputTokens: 256, idempotencyKey: key, ...changes });
  f.submit = (key, changes) => f.api.submit('agent', 'project-a', f.body(key, changes));
  f.money = () => balance(f.store, f.profile.fundingAccount, f.profile.asset);
  f.advance = () => { f.time += 60001; };
  f.result = (p, changes = {}) => ({ work: 'completed', providerRequestId: 'provider-' + p.requestId,
    output: { model: f.profile.model, text: 'Test result' }, receipt: {
      effectKey: p.effectKey, requestHash: p.requestHash, profileHash: p.quote.profileHash, quoteId: p.quote.id,
      providerId: p.profile.providerId, accountId: p.profile.accountId, providerRequestId: 'provider-' + p.requestId,
      asset: p.profile.asset, actual: '120', final: true, proofHash: costProof }, ...changes });
  return f;
}

test('disabled access and unverifiable ceilings cannot reserve money or buy inference', async t => {
  const f = await fixture(t); f.enabled = false;
  await assert.rejects(f.submit(), { code: 'inference_disabled' }); assert.equal(f.quotes.length, 0);
  f.enabled = true; f.quoteTrusted = false;
  await assert.rejects(f.submit(), { code: 'inference_quote_unverified' });
  assert.equal((await f.money()).available, '1000'); assert.equal(f.calls.length, 0);
  await assert.rejects(f.submit('model-change', { model: 'another-model' }), { code: 'inference_request_outside_profile' });
  await assert.rejects(f.submit('profile-change', { profileHash: digest({ consent: 'other-profile' }) }), { code: 'inference_profile_changed' });
});

test('parallel admission and workers preserve one purchase and one cost settlement', async t => {
  const f = await fixture(t); f.handler = p => f.result(p);
  const [a, b] = await Promise.all([f.submit(), f.submit()]); assert.equal(a.id, b.id);
  assert.equal((await f.money()).reserved, '200');
  await Promise.all([f.api.run(), f.api.run()]); assert.equal(f.calls.length, 1);
  const view = await f.api.get('agent', 'project-a', a.id);
  assert.equal(view.work, 'completed'); assert.equal(view.cost.actual, '120');
  assert.deepEqual(await f.api.output('agent', 'project-a', a.id), { model: 'test-model', text: 'Test result' });
  assert.deepEqual(await f.money(), { account: f.profile.fundingAccount, asset: f.profile.asset, available: '880', reserved: '0', spent: '120' });
  await f.submit(); assert.equal(f.calls.length, 1);
  await assert.rejects(f.submit('one', { input: 'Changed' }), { code: 'idempotency_conflict' });
  await assert.rejects(f.api.get('agent', 'project-b', a.id), { code: 'scope_denied' });
});

test('funded organization balance never replaces a project allowance', async t => {
  const f = await fixture(t);
  await f.submit('a'); await f.submit('b');
  await assert.rejects(f.submit('c'), { code: 'inference_allowance_exhausted' });
  assert.equal((await f.money()).available, '600');
  await f.api.submit('owner', 'project-b', f.body('b-own')); assert.equal((await f.money()).reserved, '600');
});

test('revocation, expired quotes and profile changes release only unsent work', async t => {
  const f = await fixture(t), a = await f.submit(); f.revoked = true;
  await f.api.run(); assert.equal(f.calls.length, 0); assert.equal((await f.money()).reserved, '0');
  assert.equal((await f.api.get('owner', 'project-a', a.id)).cost.state, 'void');
  f.revoked = false; const b = await f.submit('expired'); f.time += 300001;
  await f.api.run(); assert.equal((await f.api.get('owner', 'project-a', b.id)).work, 'cancelled');
  const c = await f.submit('changed-profile');
  await f.store.transaction(async tx => {
    const p = await tx.read('inference-profiles', f.profile.id);
    await tx.write('inference-profiles', f.profile.id, { ...p.value, model: 'replacement' }, p.revision);
  });
  await f.api.run(); assert.equal((await f.api.get('owner', 'project-a', c.id)).cost.state, 'void');
  assert.equal(f.calls.length, 0); assert.equal((await f.money()).available, '1000');
});

test('unknown dispatch survives disk restart and revoked access without another purchase', async t => {
  const f = await fixture(t), a = await f.submit();
  f.handler = async () => { throw Error('timeout after send'); }; await f.api.run();
  assert.equal((await f.money()).reserved, '200');
  await assert.rejects(f.jobs.cancel('owner', 'project-a', a.jobId), { code: 'effect_requires_reconciliation' });
  f.revoked = true; f.enabled = false; await f.restart(); f.advance();
  f.handler = p => f.result(p); await f.api.run();
  assert.deepEqual(f.calls.map(c => c.mode), ['dispatch', 'reconcile']);
  assert.equal(f.calls[0].effectKey, f.calls[1].effectKey);
  assert.equal((await f.money()).spent, '120'); assert.equal((await f.money()).reserved, '0');
  await assert.rejects(f.api.get('agent', 'project-a', a.id), { code: 'scope_denied' });
});

test('output and best-effort cost do not settle a missing or wrong final receipt', async t => {
  const f = await fixture(t), a = await f.submit();
  f.handler = p => f.result(p, { receipt: null, provisionalCost: '0' }); await f.api.run();
  let view = await f.api.get('agent', 'project-a', a.id);
  assert.equal(view.work, 'completed'); assert.equal(view.cost.actual, null); assert.equal((await f.money()).reserved, '200');
  f.advance(); f.handler = p => { const r = f.result(p); r.receipt.accountId = 'another-account'; return r; };
  await f.api.run(); assert.equal((await f.money()).reserved, '200');
  f.advance(); f.receiptTrusted = false; f.handler = p => f.result(p); await f.api.run();
  assert.equal((await f.money()).spent, '0');
  f.advance(); f.receiptTrusted = true; await f.api.run();
  view = await f.api.get('agent', 'project-a', a.id); assert.equal(view.cost.actual, '120');
});

test('changed, oversized and reused receipts cannot create another debit or release', async t => {
  const f = await fixture(t), a = await f.submit();
  f.handler = p => f.result(p, { work: 'unknown', output: null }); await f.api.run();
  assert.equal((await f.money()).spent, '120');
  f.advance(); f.handler = p => { const r = f.result(p); r.receipt.actual = '119'; return r; };
  await f.api.run(); assert.equal((await f.money()).spent, '120');
  f.advance(); f.handler = p => f.result(p); await f.api.run();
  const previous = f.calls[0], b = await f.submit('different-request');
  f.handler = p => { const r = f.result(p); r.providerRequestId = r.receipt.providerRequestId = 'provider-' + previous.requestId; return r; };
  await f.api.run(); assert.equal((await f.money()).reserved, '200');
  f.advance(); f.handler = p => { const r = f.result(p); r.receipt.actual = '201'; return r; };
  await f.api.run(); assert.equal((await f.api.get('agent', 'project-a', b.id)).cost.actual, null);
  assert.equal((await f.api.get('agent', 'project-a', a.id)).cost.actual, '120');
});

test('unsent cancellation releases the reservation atomically and never dispatches', async t => {
  const f = await fixture(t), a = await f.submit();
  await f.jobs.cancel('owner', 'project-a', a.jobId);
  await f.api.run(); assert.equal(f.calls.length, 0); assert.equal((await f.money()).reserved, '0');
  assert.equal((await f.api.get('owner', 'project-a', a.id)).work, 'cancelled');
});

test('a lost acknowledgement of effect intent cannot release funds or trigger a new dispatch', async t => {
  const f = await fixture(t), a = await f.submit();
  const begin = f.jobs.beginEffect;
  f.jobs.beginEffect = async (...args) => { await begin(...args); throw Error('commit acknowledgement lost'); };
  await f.api.run(); assert.equal(f.calls.length, 0); assert.equal((await f.money()).reserved, '200');
  await f.restart(); f.advance(); f.handler = () => null;
  await f.api.run(); assert.deepEqual(f.calls.map(c => c.mode), ['reconcile']);
  assert.equal((await f.api.get('owner', 'project-a', a.id)).cost.actual, null);
});

test('Surplus wire preparation pins providers and treats inline cost and response IDs as unverified', async t => {
  const f = await fixture(t), wire = surplusTextRequest(f.profile, { ...f.body(), provider: 'attacker', stream: true });
  assert.equal(wire.origin, 'https://api.surplusintelligence.ai');
  assert.deepEqual(wire.body.provider, ['openai']); assert.equal(wire.body.stream, false);
  assert.equal(wire.body.max_tokens, 256); assert.equal(wire.headers, undefined);
  const body = { id: 'not-a-verified-log-id', model: 'test-model', choices: [{ finish_reason: 'stop', message: { content: 'hi' } }], usage: { buyer_cost_micro: 0 } };
  const result = surplusTextObservation(f.profile, body);
  assert.equal(result.provisionalCost, '0'); assert.equal(result.receipt, null); assert.equal(result.providerRequestId, null);
  delete body.usage; assert.equal(surplusTextObservation(f.profile, body).provisionalCost, null);
  assert.equal(surplusTextObservation(f.profile, body, { 'x-si-truncated': '1' }).work, 'unknown');
  assert.equal(surplusTextObservation(f.profile, { ...body, model: 'another-model' }).work, 'unknown');
  assert.throws(() => surplusTextRequest({ ...f.profile, providers: [] }, f.body()), { code: 'invalid_inference_profile' });
});
