import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createNetwork, effectiveUpgradeRules } from '../src/index.mjs';
import { digest } from '../src/shared/index.mjs';
import { checkImports } from '../scripts/check-boundaries.mjs';
const OWNER = '0xBb145cA83272c3806D4dDc75cA1D5514789cF1C5';
const SPONSOR = 'sponsor:' + OWNER.toLowerCase();
const ASSET = 'test:1/asset:REVIEW';
const INPUT = digest({ source: 'fixed-test-commit' });
const throws = (fn, code) => assert.rejects(fn, { code });
async function fixture(t, initialFunding = '1000') {
    const dir = mkdtempSync(join(tmpdir(), 'claus-network-'));
    const verified = new Map();
    let serial = 0;
    const f = {
        path: join(dir, 'state.sqlite'), clock: 1800000000000, offerOverrides: {},
        revoked: new Set(),
        options: null, api: null
    };
    const check = (actor, action, scope) => {
        if (f.revoked.has(actor))
            return false;
        if (actor === OWNER)
            return true;
        if (actor === 'worker')
            return ['review.report', 'review.settle'].includes(action);
        return ['review.quote', 'review.admit', 'review.read'].includes(action) && actor === scope.projectId;
    };
    f.options = {
        databasePath: f.path, ownerAddress: OWNER, authorize: check, now: () => f.clock,
        provider: {
            id: 'fixture-provider',
            async quote({ inputHash }) {
                return { id: 'offer-' + ++serial, provider: 'fixture-provider', asset: ASSET,
                    maximum: '100', expiresAt: f.clock + 60000, inputHash, ...f.offerOverrides };
            }
        },
        verifyCost: receipt => verified.get(receipt.id) === digest(receipt)
    };
    f.api = createNetwork(f.options);
    (await f.api.bootstrap({ actor: OWNER }));
    t.after(async () => { (await f.api.close()); rmSync(dir, { recursive: true, force: true }); });
    f.fund = async (account, value, receiptId = 'fund-' + ++serial, asset = ASSET) => (await f.api.billing.recordFunding({ actor: OWNER, account, asset, amount: value, receiptId }));
    if (initialFunding !== '0')
        (await f.fund(SPONSOR, initialFunding));
    f.balance = async (account = SPONSOR, asset = ASSET) => (await f.api.billing.balance({ actor: OWNER, account, asset }));
    f.quote = async (id = 'quote-' + ++serial, projectId = 'alice') => (await f.api.reviews.quote({ actor: projectId, id, projectId, inputHash: INPUT }));
    f.admit = async (quote, key = 'job-' + quote.id) => (await f.api.reviews.admit({
        actor: quote.projectId, projectId: quote.projectId, quoteId: quote.id,
        inputHash: quote.inputHash, idempotencyKey: key
    }));
    f.policy = async (module, config, version = 'version-' + ++serial) => {
        (await f.api.policies.publish({ actor: OWNER, module, version, config }));
        let generation = 0;
        try {
            generation = (await f.api.policies.active(module)).generation;
        }
        catch (error) {
            if (error.code !== 'policy_not_active')
                throw error;
        }
        return (await f.api.policies.activate({ actor: OWNER, module, version, expectedGeneration: generation }));
    };
    f.receipt = (quote, actual = '60', id = 'receipt-' + ++serial) => {
        const receipt = { id, provider: quote.offer.provider, providerQuoteId: quote.offer.id,
            asset: quote.offer.asset, inputHash: quote.inputHash, actual };
        verified.set(id, digest(receipt));
        return receipt;
    };
    f.settle = async (job, receipt) => (await f.api.reviews.recordCost({
        actor: 'worker', projectId: job.projectId, jobId: job.id, receipt
    }));
    return f;
}
test('launch reviews are free to the project and reserve real sponsor cost', async (t) => {
    const f = (await fixture(t));
    const quote = await f.quote();
    assert.deepEqual(quote.maximum, { provider: '100', network: '0', project: '0', sponsor: '100' });
    const job = (await f.admit(quote));
    assert.equal(job.billing, 'reserved');
    assert.equal((await f.balance()).available, '900');
    assert.equal((await f.balance()).reserved, '100');
    assert.equal((await f.balance('project:alice')).spent, '0');
});
test('a fee change affects new quotes without repricing accepted or unaccepted old quotes', async (t) => {
    const f = (await fixture(t));
    const old = await f.quote();
    (await f.policy('review.fees', { rateBps: 1000, flatByAsset: { [ASSET]: '2' } }));
    const current = await f.quote();
    assert.equal(current.maximum.project, '12');
    assert.equal(old.maximum.project, '0');
    (await f.fund('project:alice', '12'));
    const first = (await f.admit(old));
    const second = (await f.admit(current));
    assert.equal((await f.settle(first, f.receipt(old))).actual.project, '0');
    assert.equal((await f.settle(second, f.receipt(current))).actual.project, '8');
    assert.equal((await f.balance('project:alice')).available, '4');
    assert.equal((await f.balance('project:alice')).spent, '8');
});
test('versions are immutable and caller mutation cannot alter stored policy', async (t) => {
    const f = (await fixture(t));
    const current = (await f.api.policies.active('review.fees'));
    current.config.rateBps = 9000;
    assert.equal((await f.api.policies.active('review.fees')).config.rateBps, 0);
    (await throws(async () => (await f.api.policies.publish({
        actor: OWNER, module: 'review.fees', version: 'launch-v1',
        config: { rateBps: 1, flatByAsset: {} }
    })), 'immutable_policy_version'));
});
test('activation uses CAS and rollback increments generation, preventing ABA', async (t) => {
    const f = (await fixture(t));
    const changed = (await f.policy('review.fees', { rateBps: 10, flatByAsset: {} }, 'fee-v2'));
    (await throws(async () => (await f.api.policies.activate({
        actor: OWNER, module: 'review.fees', version: 'launch-v1', expectedGeneration: 1
    })), 'revision_conflict'));
    const restored = (await f.api.policies.activate({
        actor: OWNER, module: 'review.fees', version: 'launch-v1', expectedGeneration: changed.generation
    }));
    assert.equal(restored.generation, 3);
    assert.equal((await f.api.policies.active('review.sponsorship')).generation, 1);
});
test('invalid or executable configuration and unknown modules fail closed', async (t) => {
    const f = (await fixture(t));
    const publish = async (module, config) => (await f.api.policies.publish({ actor: OWNER, module, version: 'bad', config }));
    (await throws(() => publish('review.fees', { rateBps: -1, flatByAsset: {} }), 'invalid_integer'));
    (await throws(() => publish('review.fees', { rateBps: 0, flatByAsset: {}, script: 'run()' }), 'invalid_shape'));
    (await throws(() => publish('review.fees', { rateBps: 0, flatByAsset: { [ASSET]: '-1' } }), 'invalid_amount'));
    (await throws(() => publish('review.fees', { rateBps: 0, flatByAsset: {}, run: () => { } }), 'invalid_json'));
    (await throws(() => publish('holder-benefits', { enabled: true }), 'unknown_policy_module'));
});
test('project actors cannot administer policy or invent funded money', async (t) => {
    const f = (await fixture(t));
    (await throws(async () => (await f.api.policies.activate({
        actor: 'alice', module: 'review.fees', version: 'launch-v1', expectedGeneration: 1
    })), 'access_denied'));
    (await throws(async () => (await f.api.billing.recordFunding({
        actor: 'alice', account: SPONSOR, asset: ASSET, amount: '100', receiptId: 'fake'
    })), 'access_denied'));
    (await throws(async () => (await f.api.history({ actor: 'alice' })), 'access_denied'));
});
test('missing authorization port defaults to denial', async (t) => {
    const f = (await fixture(t));
    const api = createNetwork({ databasePath: ':memory:', ownerAddress: OWNER });
    t.after(async () => (await api.close()));
    (await throws(async () => (await api.bootstrap({ actor: OWNER })), 'access_denied'));
});
test('insufficient sponsor funding never falls back to charging the project', async (t) => {
    const f = (await fixture(t, '0'));
    (await f.fund('project:alice', '100'));
    const quote = await f.quote();
    (await throws(async () => (await f.admit(quote)), 'funding_insufficient'));
    assert.equal((await f.balance('project:alice')).available, '100');
    (await f.fund(SPONSOR, '100'));
    (await f.admit(quote));
    assert.equal((await f.balance()).reserved, '100');
});
test('project funding failure rolls back the sponsor reservation atomically', async (t) => {
    const f = (await fixture(t));
    (await f.policy('review.fees', { rateBps: 1000, flatByAsset: {} }));
    const quote = await f.quote();
    (await throws(async () => (await f.admit(quote)), 'funding_insufficient'));
    assert.equal((await f.balance()).available, '1000');
    assert.equal((await f.balance()).reserved, '0');
    (await f.fund('project:alice', '10'));
    (await f.admit(quote));
});
test('idempotent admission and alternate client keys cannot purchase a quote twice', async (t) => {
    const f = (await fixture(t));
    const quote = await f.quote();
    const job = (await f.admit(quote));
    assert.deepEqual((await f.admit(quote)), job);
    (await throws(async () => (await f.admit(quote, 'different-key')), 'quote_already_admitted'));
    assert.equal((await f.balance()).reserved, '100');
});
test('a reused upstream offer cannot be bought through another local quote', async (t) => {
    const f = (await fixture(t));
    f.offerOverrides.id = 'same-upstream-offer';
    const first = await f.quote(), second = await f.quote();
    (await f.admit(first));
    (await throws(async () => (await f.admit(second)), 'provider_offer_already_admitted'));
    assert.equal((await f.balance()).reserved, '100');
});
test('idempotency keys bind their exact input and quote', async (t) => {
    const f = (await fixture(t));
    const first = await f.quote(), second = await f.quote();
    (await f.admit(first, 'logical-operation'));
    (await throws(async () => (await f.admit(second, 'logical-operation')), 'idempotency_conflict'));
    (await throws(async () => (await f.admit({ ...second, inputHash: digest('changed') })), 'quote_input_mismatch'));
});
test('revoked sponsorship blocks old unaccepted free quotes without repricing', async (t) => {
    const f = (await fixture(t));
    const quote = await f.quote();
    (await f.policy('review.sponsorship', { enabled: false, payer: OWNER, capabilities: ['review.code'] }));
    (await throws(async () => (await f.admit(quote)), 'sponsorship_revoked'));
    assert.equal((await f.balance()).reserved, '0');
    assert.equal((await f.balance('project:alice')).spent, '0');
});
test('expiry blocks new admission but does not hide an already accepted job', async (t) => {
    const f = (await fixture(t));
    const accepted = await f.quote(), pending = await f.quote();
    const job = (await f.admit(accepted));
    f.clock += 60001;
    (await throws(async () => (await f.admit(pending)), 'quote_expired'));
    assert.deepEqual((await f.admit(accepted)), job);
});
test('project separation and fresh actor revocation apply to job access', async (t) => {
    const f = (await fixture(t));
    const quote = await f.quote();
    const job = (await f.admit(quote));
    (await throws(async () => (await f.api.reviews.job({ actor: 'bob', projectId: 'bob', jobId: job.id })), 'not_found'));
    (await throws(async () => (await f.api.reviews.job({ actor: 'bob', projectId: 'alice', jobId: job.id })), 'access_denied'));
    f.revoked.add('alice');
    (await throws(async () => (await f.admit(quote)), 'access_denied'));
});
test('revocation during an asynchronous provider quote prevents committing it', async (t) => {
    const f = (await fixture(t));
    const pending = f.quote('revoked-while-waiting');
    f.revoked.add('alice');
    await assert.rejects(pending, { code: 'access_denied' });
    f.revoked.delete('alice');
    const quote = await f.quote('revoked-while-waiting');
    assert.equal(quote.id, 'revoked-while-waiting');
});
test('unknown outcomes retain their reservation until separately verified cost', async (t) => {
    const f = (await fixture(t));
    const quote = await f.quote(), job = (await f.admit(quote));
    (await f.api.reviews.markUnknown({ actor: 'worker', projectId: 'alice', jobId: job.id }));
    assert.equal((await f.balance()).reserved, '100');
    const settled = (await f.settle(job, f.receipt(quote, '65')));
    assert.equal(settled.work, 'outcome_unknown');
    assert.equal(settled.billing, 'settled');
    assert.equal((await f.balance()).available, '935');
    assert.equal((await f.balance()).spent, '65');
    assert.equal((await f.balance()).reserved, '0');
});
test('wrong asset, wrong request, excessive or unverified costs preserve funding', async (t) => {
    const f = (await fixture(t));
    const quote = await f.quote(), job = (await f.admit(quote));
    (await throws(async () => (await f.settle(job, { ...f.receipt(quote), asset: 'other-asset' })), 'cost_receipt_mismatch'));
    (await throws(async () => (await f.settle(job, { ...f.receipt(quote), inputHash: digest('wrong') })), 'cost_receipt_mismatch'));
    (await throws(async () => (await f.settle(job, f.receipt(quote, '101'))), 'cost_exceeds_reservation'));
    (await throws(async () => (await f.settle(job, { ...f.receipt(quote), actual: '0' })), 'cost_not_verified'));
    assert.equal((await f.balance()).reserved, '100');
});
test('settlement replay does not charge twice and conflicting reuse fails', async (t) => {
    const f = (await fixture(t));
    const quote = await f.quote(), job = (await f.admit(quote));
    const receipt = f.receipt(quote, '60', 'fixed-receipt');
    const settled = (await f.settle(job, receipt));
    assert.deepEqual((await f.settle(job, receipt)), settled);
    (await throws(async () => (await f.settle(job, f.receipt(quote, '61', 'fixed-receipt'))), 'cost_receipt_conflict'));
    (await throws(async () => (await f.settle(job, f.receipt(quote, '60', 'replacement-receipt'))), 'job_already_settled'));
    assert.equal((await f.balance()).spent, '60');
});
test('funding receipts are idempotent and bound to account, amount and asset', async (t) => {
    const f = (await fixture(t, '0'));
    (await f.fund(SPONSOR, '50', 'one-deposit'));
    (await f.fund(SPONSOR, '50', 'one-deposit'));
    (await throws(async () => (await f.fund('project:alice', '50', 'one-deposit')), 'funding_receipt_conflict'));
    (await throws(async () => (await f.fund(SPONSOR, '51', 'one-deposit')), 'funding_receipt_conflict'));
    assert.equal((await f.balance()).available, '50');
    assert.equal((await f.balance(SPONSOR, 'another-asset')).available, '0');
});
test('restart preserves policy, outstanding reservations and idempotency', async (t) => {
    const f = (await fixture(t));
    const quote = await f.quote(), job = (await f.admit(quote));
    (await f.policy('review.fees', { rateBps: 25, flatByAsset: {} }, 'later-fees'));
    (await f.api.close());
    f.api = createNetwork(f.options);
    (await f.api.bootstrap({ actor: OWNER }));
    assert.equal((await f.api.policies.active('review.fees')).version, 'later-fees');
    assert.equal((await f.balance()).reserved, '100');
    assert.deepEqual((await f.admit(quote)), job);
});
test('the same owner with different address casing does not reset bootstrap', async (t) => {
    const f = (await fixture(t));
    (await f.api.close());
    f.api = createNetwork({ ...f.options, ownerAddress: OWNER.toLowerCase() });
    (await f.api.bootstrap({ actor: OWNER }));
    assert.equal((await f.api.policies.active('review.sponsorship')).generation, 1);
    assert.equal((await f.balance()).available, '1000');
});
test('amounts beyond JavaScript safe integer precision reconcile exactly', async (t) => {
    const f = (await fixture(t, '0'));
    f.offerOverrides.maximum = '9007199254740993';
    (await f.fund(SPONSOR, '9007199254740993'));
    const quote = await f.quote(), job = (await f.admit(quote));
    (await f.settle(job, f.receipt(quote, '9007199254740992')));
    assert.equal((await f.balance()).available, '1');
    assert.equal((await f.balance()).spent, '9007199254740992');
});
test('concurrent independent connections cannot overspend sponsor funds', { timeout: 10000 }, async (t) => {
    const f = (await fixture(t, '100'));
    const quotes = await Promise.all([f.quote('q-a', 'alice'), f.quote('q-b', 'bob')]);
    const moduleUrl = new URL('../src/index.mjs', import.meta.url).href;
    const runs = quotes.map(quote => new Promise((resolve, reject) => {
        const worker = new Worker('const {parentPort,workerData}=require("node:worker_threads");' +
            'import(workerData.moduleUrl).then(({createNetwork})=>{' +
            'const api=createNetwork({databasePath:workerData.path,ownerAddress:workerData.owner,authorize:()=>true,now:()=>workerData.now});' +
            'parentPort.postMessage("ready");parentPort.once("message",async()=>{' +
            'try{await api.reviews.admit(workerData.request);parentPort.postMessage("accepted");}' +
            'catch(e){parentPort.postMessage(e.code||e.message);}finally{await api.close();}});}).catch(e=>{throw e;});', { eval: true, workerData: {
                moduleUrl, path: f.path, owner: OWNER, now: f.clock,
                request: { actor: quote.projectId, projectId: quote.projectId, quoteId: quote.id,
                    inputHash: INPUT, idempotencyKey: 'parallel' }
            } });
        t.after(() => worker.terminate());
        worker.on('error', reject);
        worker.on('message', message => {
            if (message === 'ready')
                worker.postMessage('start');
            else
                resolve(message);
        });
    }));
    assert.deepEqual((await Promise.all(runs)).sort(), ['accepted', 'funding_insufficient']);
    assert.equal((await f.balance()).reserved, '100');
    assert.equal((await f.balance()).available, '0');
});
test('loosening configurable rules does not weaken accepted protection floors', () => {
    const accepted = { minDelaySeconds: 3600, requiredReviews: 2, maxFeeBps: 100 };
    assert.deepEqual(effectiveUpgradeRules({ minDelaySeconds: 0, requiredReviews: 0, maxFeeBps: 10000 }, accepted), accepted);
    assert.deepEqual(effectiveUpgradeRules({ minDelaySeconds: 7200, requiredReviews: 3, maxFeeBps: 50 }, accepted), { minDelaySeconds: 7200, requiredReviews: 3, maxFeeBps: 50 });
});
test('module lint rejects private cross-imports, cycles and ambient IO', () => {
    const modules = [
        { id: 'a', path: 'src/a/', imports: ['b'], builtins: [] },
        { id: 'b', path: 'src/b/', imports: [], builtins: [] }
    ];
    const sources = { 'src/a/index.mjs': 'import { value } from "../b/index.mjs";',
        'src/b/index.mjs': 'export const value = 1;', 'src/b/private.mjs': 'export const secret = 2;' };
    assert.equal(checkImports(sources, modules).imports, 1);
    assert.throws(() => checkImports({ ...sources, 'src/a/index.mjs': 'import "../b/private.mjs";' }, modules), /private_or_forbidden/);
    assert.throws(() => checkImports({ ...sources, 'src/a/index.mjs': 'fetch("https://example.com");' }, modules), /dynamic_or_external/);
    assert.throws(() => checkImports(sources, [modules[0], { ...modules[1], imports: ['a'] }]), /module_cycle/);
});
