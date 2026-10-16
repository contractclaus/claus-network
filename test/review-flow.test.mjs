import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createApplication } from '../runtime/server.mjs';
import { openStore } from '../src/storage/index.mjs';
import { digest } from '../src/shared/index.mjs';
import { verifyPublicSource } from '../adapters/public-source.mjs';
import { createImdPayment } from '../adapters/imd-payment.mjs';
import { createSealer } from '../adapters/secrets.mjs';

async function fixture(t, options = {}) {
  const store = openStore(':memory:'); t.after(() => store.close());
  const account = privateKeyToAccount(generatePrivateKey());
  const asset = 'eip155:1/erc20:test', ownerAddress = options.networkOwner ? account.address.toLowerCase() : '0x' + '11'.repeat(20);
  let time = Date.now();
  let quotes = 0;
  const provider = { id: 'test-provider', quote: async ({ inputHash }) => ({ id: 'offer-' + ++quotes,
    provider: 'test-provider', asset, maximum: '5', expiresAt: Date.now() + 600000, inputHash }) };
  const app = createApplication({ store, now: () => time, rateSalt: 'x'.repeat(32), reviewPorts: { ownerAddress, provider,
    validatePublicBuild: options.validatePublicBuild, verifyCost: async () => true, verifySource: options.verifySource ?? (async ({ input }) => ({ inputHash: digest(input) })) } });
  const challenge = await app.identity.challenge({ address: account.address });
  const session = await app.identity.session({ challengeId: challenge.id, signature: await account.signMessage({ message: challenge.message }) });
  const actor = await app.identity.authenticate(session.token);
  const project = await app.identity.createProject(actor, { name: 'Read service', slug: 'read-service', idempotencyKey: 'first' });
  const snapshot = await app.projects.createSnapshot(actor, project.id, { files: [{ path: 'A.sol', content: 'contract A {}' }], expectedProjectRevision: 1 });
  const build = await app.builds.submit(actor, project.id, { snapshotId: snapshot.id, entry: 'A.sol', contract: 'A', idempotencyKey: 'build' });
  await app.builds.runOne(async () => ({ status: 'compiled' }));
  const { network, workerActor, flow } = app.reviewSystem;
  await network.bootstrap({ actor: workerActor });
  await network.billing.recordFunding({ actor: workerActor, account: 'sponsor:' + ownerAddress, asset, amount: options.funding ?? '50', receiptId: 'local-test-only' });
  if (!options.publicOnly) await store.transaction(tx => tx.write('review-pilots', project.id, { enabled: true, expiresAt: Date.now() + 600000, maximumPerReview: '5' }, 0));
  const publish = () => app.projects.publishSource(actor, project.id, { snapshotId: snapshot.id, expectedRevision: 0, published: true });
  const input = { buildId: build.id, repoUrl: 'https://github.com/example/project', baseCommit: 'a'.repeat(40), idempotencyKey: 'review' };
  return { ...app, store, actor, token: session.token, flow, network, workerActor, projectId: project.id, snapshot, input, publish, quotes: () => quotes, asset, ownerAddress, advance: ms => { time += ms; } };
}

test('only the network owner grants sponsor access; stale revisions and excess ceilings are rejected', async t => {
  const f = await fixture(t, { networkOwner: true });
  const prior = await f.flow.pilot(f.actor, f.projectId);
  const change = { enabled: false, expiresAt: Date.now() + 600000, maximumPerReview: '5', expectedRevision: prior.revision };
  assert.equal((await f.flow.setPilot(f.actor, f.projectId, change)).enabled, false);
  await assert.rejects(f.flow.setPilot(f.actor, f.projectId, change), { code: 'revision_conflict' });
  await assert.rejects(f.flow.setPilot(f.actor, f.projectId, { ...change, maximumPerReview: '999999999999999999' }), { code: 'invalid_pilot' });
  const other = privateKeyToAccount(generatePrivateKey());
  const challenge = await f.identity.challenge({ address: other.address });
  const session = await f.identity.session({ challengeId: challenge.id, signature: await other.signMessage({ message: challenge.message }) });
  const actor = await f.identity.authenticate(session.token);
  await assert.rejects(f.flow.pilot(actor, f.projectId), { code: 'scope_denied' });
  await assert.rejects(f.flow.setPilot(actor, f.projectId, { ...change, expectedRevision: 2 }), { code: 'scope_denied' });
});

test('revocation before dispatch releases the reservation and stops future retries', async t => {
  const f = await fixture(t); await f.publish();
  const item = await f.flow.request(f.actor, f.projectId, f.input); await f.flow.runQuote();
  await f.flow.accept(f.actor, f.projectId, { caseId: item.id, quoteId: item.id, idempotencyKey: 'once' });
  f.advance(3600001);
  const payment = createImdPayment({ store: f.store, sealer: createSealer('11'.repeat(32)), signer: {}, provider: {} });
  const result = await f.flow.runPaid({ createPayment: () => payment });
  assert.equal(result.state, 'blocked');
  const account = await f.network.billing.balance({ actor: f.workerActor, account: 'sponsor:' + f.ownerAddress, asset: f.asset });
  assert.equal(account.reserved, '0'); assert.equal(account.available, '50');
  assert.equal((await f.flow.runPaid({ createPayment: () => payment })).idle, true);
});

test('a confirmed provider failure retains its real charge and terminates the workflow', async t => {
  const f = await fixture(t); await f.publish();
  const item = await f.flow.request(f.actor, f.projectId, f.input); await f.flow.runQuote();
  await f.flow.accept(f.actor, f.projectId, { caseId: item.id, quoteId: item.id, idempotencyKey: 'once' });
  const state = { state: 'provider_paid', outcome: { admission: { result: { jobId: 'failed-provider' } } } };
  const result = await f.flow.runPaid({ createPayment: () => ({ status: async () => state, reconcile: async () => state }),
    provider: { report: async () => ({ complete: false, state: 'failed' }) },
    costReceipt: async ({ offer, inputHash }) => ({ id: 'charge-for-failed-job', provider: offer.provider,
      providerQuoteId: offer.id, inputHash, asset: f.asset, actual: '5' }) });
  assert.equal(result.state, 'failed');
  const review = await f.flow.get(f.actor, f.projectId, item.id);
  assert.equal(review.job.work, 'failed'); assert.equal(review.job.billing, 'settled');
  const account = await f.network.billing.balance({ actor: f.workerActor, account: 'sponsor:' + f.ownerAddress, asset: f.asset });
  assert.equal(account.spent, '5'); assert.equal(account.available, '45'); assert.equal(account.reserved, '0');
});

test('review admission atomically reserves sponsor funds and enqueues one cancel-safe workflow', async t => {
  const f = await fixture(t);
  await assert.rejects(f.flow.request(f.actor, f.projectId, f.input), { code: 'source_not_published' });
  await f.publish();
  const item = await f.flow.request(f.actor, f.projectId, f.input);
  assert.deepEqual(await f.flow.request(f.actor, f.projectId, f.input), item);
  assert.equal((await f.flow.runQuote()).state, 'complete'); assert.equal(f.quotes(), 1);
  const quoted = await f.flow.get(f.actor, f.projectId, item.id);
  assert.equal(quoted.quote.maximum.project, '0');
  const accept = { caseId: item.id, quoteId: quoted.quoteId, idempotencyKey: 'accept-once' };
  const job = await f.flow.accept(f.actor, f.projectId, accept);
  assert.deepEqual(await f.flow.accept(f.actor, f.projectId, accept), job);
  const account = { actor: f.workerActor, account: 'sponsor:' + f.ownerAddress, asset: f.asset };
  assert.equal((await f.network.billing.balance(account)).reserved, '5');
  const admitted = await f.flow.get(f.actor, f.projectId, item.id);
  assert.equal((await f.jobs.get(f.actor, f.projectId, admitted.executionJobId)).kind, 'review-execute');
  await f.jobs.cancel(f.actor, f.projectId, admitted.executionJobId);
  const cancelled = await f.flow.get(f.actor, f.projectId, item.id);
  assert.equal(cancelled.job.work, 'cancelled'); assert.equal(cancelled.job.billing, 'void');
  assert.equal((await f.network.billing.balance(account)).available, '50');
  const retry = await f.flow.request(f.actor, f.projectId, { ...f.input, idempotencyKey: 'after-proven-cancellation' });
  assert.notEqual(retry.id, item.id);
  assert.equal((await f.flow.request(f.actor, f.projectId, f.input)).id, item.id);
  assert.equal((await f.flow.get(f.actor, f.projectId, item.id)).job.billing, 'void');
});

test('source mismatch and withdrawn publication cannot reach paid admission', async t => {
  const f = await fixture(t, { verifySource: async () => { throw Object.assign(Error('different source'), { code: 'source_mismatch' }); } });
  await f.publish(); const item = await f.flow.request(f.actor, f.projectId, f.input);
  assert.equal((await f.flow.runQuote()).state, 'failed'); assert.equal(f.quotes(), 0);
  await assert.rejects(f.flow.accept(f.actor, f.projectId, { caseId: item.id, quoteId: item.id, idempotencyKey: 'x' }), { code: 'quote_not_ready' });
  const good = await fixture(t); await good.publish();
  const offered = await good.flow.request(good.actor, good.projectId, good.input); await good.flow.runQuote();
  await good.projects.publishSource(good.actor, good.projectId, { snapshotId: good.snapshot.id, expectedRevision: 1, published: false });
  await assert.rejects(good.flow.accept(good.actor, good.projectId, { caseId: offered.id, quoteId: offered.id, idempotencyKey: 'x' }), { code: 'source_not_published' });
});

test('a paid unknown review reconciles once after revocation without buying it again', async t => {
  const f = await fixture(t); await f.publish();
  const agent = await f.identity.createAgent(f.actor, f.projectId, { name: 'Reviewer' });
  const mandate = await f.identity.grant(f.actor, f.projectId, { principalId: agent.id,
    scopes: ['artifact.read', 'review.quote', 'review.admit', 'review.read'], expiresAt: Date.now() + 600000 });
  const credential = await f.identity.issueCredential(f.actor, { mandateId: mandate.id });
  const actor = await f.identity.authenticate(credential.token);
  const item = await f.flow.request(actor, f.projectId, f.input); await f.flow.runQuote();
  await f.flow.accept(actor, f.projectId, { caseId: item.id, quoteId: item.id, idempotencyKey: 'once' });
  let payment = null, sent = 0, polls = 0;
  const createPayment = claim => ({
    status: async () => payment,
    prepare: async offerId => {
      assert.equal(await f.flow.paymentAuthority(claim, { offerId, amount: '5' }, f.store), true);
      return payment = { state: 'prepared' };
    },
    submit: async offerId => {
      assert.equal(await f.flow.paymentAuthority(claim, { offerId, amount: '5' }, f.store), true);
      sent++; return payment = { state: 'outcome_unknown' };
    },
    reconcile: async () => ++polls === 1 ? payment : payment = { state: 'provider_paid', outcome: { admission: { result: { jobId: 'provider-one' } } } }
  });
  const ports = { createPayment, provider: { report: async jobId => ({ complete: true, jobId, report: 'Independent report',
    submissions: { repoUrl: f.input.repoUrl, baseCommit: f.input.baseCommit, submissions: [{ accepted: true, baseCommit: f.input.baseCommit }] } }) },
    costReceipt: async ({ state, offer, inputHash }) => state.state !== 'provider_paid' ? null : ({ id: 'verified-receipt-one',
      provider: offer.provider, providerQuoteId: offer.id, inputHash, asset: f.asset, actual: '5' }) };
  assert.equal((await f.flow.runPaid(ports)).state, 'waiting');
  await f.identity.revoke(f.actor, 'mandate', mandate.id); f.advance(60001);
  assert.equal((await f.flow.runPaid(ports)).state, 'complete'); assert.equal(sent, 1);
  const result = await f.flow.get(f.actor, f.projectId, item.id);
  assert.equal(result.job.work, 'completed'); assert.equal(result.job.billing, 'settled');
  assert.equal(result.job.actual.project, '0');
  const balance = await f.network.billing.balance({ actor: f.workerActor, account: 'sponsor:' + f.ownerAddress, asset: f.asset });
  assert.equal(balance.reserved, '0'); assert.equal(balance.spent, '5');
  assert.equal((await f.projects.graph()).nodes.length, 1);
  await f.projects.publish(f.actor, f.projectId, { published: true, expectedRevision: 0 });
  assert.equal((await f.projects.publicProject('read-service')).evidence.reviews.length, 0);
  await f.flow.publish(f.actor, f.projectId, { caseId: item.id, published: true, expectedRevision: 0 });
  const publicReview = (await f.projects.publicProject('read-service')).evidence.reviews[0];
  assert.equal(publicReview.providerJobId, 'provider-one'); assert.equal(publicReview.report, undefined);
  await f.flow.publish(f.actor, f.projectId, { caseId: item.id, published: false, expectedRevision: 1 });
  assert.equal((await f.projects.publicProject('read-service')).evidence.reviews.length, 0);
});

test('revoked submitter cannot dispatch a funded review and cannot cancel an uncertain payment', async t => {
  const f = await fixture(t); await f.publish();
  const agent = await f.identity.createAgent(f.actor, f.projectId, { name: 'Reviewer' });
  const mandate = await f.identity.grant(f.actor, f.projectId, { principalId: agent.id,
    scopes: ['artifact.read', 'review.quote', 'review.admit', 'review.read'], expiresAt: Date.now() + 600000 });
  const credential = await f.identity.issueCredential(f.actor, { mandateId: mandate.id });
  const actor = await f.identity.authenticate(credential.token);
  const item = await f.flow.request(actor, f.projectId, f.input); await f.flow.runQuote();
  await f.flow.accept(actor, f.projectId, { caseId: item.id, quoteId: item.id, idempotencyKey: 'x' });
  const claim = await f.jobs.claim({ kinds: ['review-execute'] });
  await f.identity.revoke(f.actor, 'mandate', mandate.id);
  await assert.rejects(f.flow.paymentAuthority(claim, { offerId: 'offer-1', amount: '5' }, f.store), { code: 'scope_denied' });
  // The state machine, not a provider error message, is the cancellation proof.
  await f.jobs.beginEffect(claim, async () => true);
  await assert.rejects(f.jobs.cancel(f.actor, f.projectId, claim.id), { code: 'effect_requires_reconciliation' });
});

test('public source verification checks every pinned file and refuses mutable redirects or substitutions', async () => {
  const files = [{ path: 'A.sol', content: 'contract A {}' }].map(f => ({ ...f, hash: digest(f) }));
  const input = { repoUrl: 'https://github.com/example/project', baseCommit: 'a'.repeat(40), sourceHash: digest(files.map(({ path, hash }) => ({ path, hash }))) };
  const fetch = async (url, options) => {
    assert.equal(options.redirect, 'error'); assert.ok(url.includes('/' + 'a'.repeat(40) + '/A.sol'));
    return new Response(files[0].content);
  };
  assert.equal((await verifyPublicSource({ input, files, fetch })).fileCount, 1);
  await assert.rejects(verifyPublicSource({ input, files, fetch: async () => new Response('different') }), { code: 'source_mismatch' });
  await assert.rejects(verifyPublicSource({ input: { ...input, repoUrl: 'https://localhost/private' }, files, fetch }), { code: 'unsupported_source_host' });
});


test('public sponsorship is separate, bounded across policy changes and never creates unfunded credit', async t => {
  const f = await fixture(t, { networkOwner: true, publicOnly: true, funding: '1', validatePublicBuild: artifact => assert.equal(artifact.status, 'compiled') });
  await f.publish();
  await assert.rejects(f.flow.request(f.actor, f.projectId, f.input), { code: 'sponsor_not_enabled' });
  const config = { enabled: true, expiresAt: Date.now() + 3600000, maximumPerReview: '5', maximumLifetime: '5',
    perOwnerDay: 2, perProjectDay: 2, globalDay: 8, activeGlobal: 8 };
  await f.flow.admission.publish(f.actor, { version: 'public-1', config });
  await f.flow.admission.activate(f.actor, { version: 'public-1', expectedGeneration: 0 });
  const item = await f.flow.request(f.actor, f.projectId, f.input);
  assert.equal((await f.flow.request(f.actor, f.projectId, { ...f.input, idempotencyKey: 'different-key-same-source' })).id, item.id);
  await f.flow.runQuote();
  const accept = { caseId: item.id, quoteId: item.id, idempotencyKey: 'paid' };
  const legacyGlobal = digest({ subject: 'global', day: Math.floor(Date.now() / 86400000), version: 'review-admission-v1' });
  await f.store.transaction(tx => tx.write('review-admission', legacyGlobal, { count: 8 }, 0));
  await assert.rejects(f.flow.accept(f.actor, f.projectId, accept), { code: 'funding_insufficient' });
  assert.equal((await f.flow.admission.get(f.actor)).committedMaximum, '0');
  await f.network.billing.recordFunding({ actor: f.workerActor, account: 'sponsor:' + f.ownerAddress, asset: f.asset, amount: '10', receiptId: 'second-test-funding' });
  await f.flow.accept(f.actor, f.projectId, accept);
  assert.equal((await f.store.read('review-admission', legacyGlobal)).value.count, 8);
  assert.equal((await f.flow.admission.get(f.actor)).committedMaximum, '5');
  const current = await f.flow.get(f.actor, f.projectId, item.id);
  await f.jobs.cancel(f.actor, f.projectId, current.executionJobId);
  assert.equal((await f.flow.admission.get(f.actor)).committedMaximum, '0');
  await f.flow.admission.publish(f.actor, { version: 'public-2', config });
  await f.flow.admission.activate(f.actor, { version: 'public-2', expectedGeneration: 1 });
  const next = await f.flow.request(f.actor, f.projectId, { ...f.input, baseCommit: 'b'.repeat(40), idempotencyKey: 'next-source' });
  await f.flow.runQuote();
  await f.flow.accept(f.actor, f.projectId, { caseId: next.id, quoteId: next.id, idempotencyKey: 'released-capacity' });
  assert.equal((await f.store.list('review-pilots')).length, 0);
  assert.equal((await f.flow.admission.get(f.actor)).committedMaximum, '5');
});

test('an explicit operator pilot quota keeps prior use and does not grant another review after exhaustion', async t => {
  const f = await fixture(t, { networkOwner: true }); await f.publish();
  const item = await f.flow.request(f.actor, f.projectId, f.input); await f.flow.runQuote();
  const keys = [f.projectId, 'global'].map(subject => digest({ subject, day: Math.floor(Date.now()/86400000), version: 'review-admission-v1' }));
  await f.store.transaction(async tx => { await tx.write('review-admission', keys[0], { count: 2 }, 0); await tx.write('review-admission', keys[1], { count: 8 }, 0); });
  const input = { caseId: item.id, quoteId: item.id, idempotencyKey: 'one-additional-review' };
  await assert.rejects(f.flow.accept(f.actor, f.projectId, input), { code: 'capacity_reached' });
  const pilot = await f.flow.pilot(f.actor, f.projectId);
  await f.flow.setPilot(f.actor, f.projectId, { enabled: true, expiresAt: pilot.expiresAt, maximumPerReview: pilot.maximumPerReview, expectedRevision: pilot.revision, perProjectDay: 3, globalDay: 9 });
  await f.flow.accept(f.actor, f.projectId, input);
  assert.deepEqual(await Promise.all(keys.map(async id => (await f.store.read('review-admission',id)).value.count)), [3,9]);
  const current = await f.flow.get(f.actor, f.projectId, item.id); await f.jobs.cancel(f.actor, f.projectId, current.executionJobId);
  const next = await f.flow.request(f.actor, f.projectId, { ...f.input, baseCommit:'b'.repeat(40), idempotencyKey:'another-source' }); await f.flow.runQuote();
  await assert.rejects(f.flow.accept(f.actor, f.projectId, { caseId:next.id,quoteId:next.id,idempotencyKey:'beyond-allocation' }), { code:'capacity_reached' });
});

test('local signing failures release unsent sponsor exposure both immediately and after restart', async t => {
  for (const resumed of [false, true]) {
    const f = await fixture(t, { networkOwner: true, publicOnly: true, validatePublicBuild: () => {} }); await f.publish();
    const config = { enabled: true, expiresAt: Date.now() + 3600000, maximumPerReview: '5', maximumLifetime: '5',
      perOwnerDay: 2, perProjectDay: 2, globalDay: 8, activeGlobal: 8 };
    await f.flow.admission.publish(f.actor, { version: 'signing-test', config });
    await f.flow.admission.activate(f.actor, { version: 'signing-test', expectedGeneration: 0 });
    const item = await f.flow.request(f.actor, f.projectId, f.input); await f.flow.runQuote();
    await f.flow.accept(f.actor, f.projectId, { caseId: item.id, quoteId: item.id, idempotencyKey: 'once' });
    const payment = createImdPayment({ store: f.store, sealer: createSealer('11'.repeat(32)), signer: {}, provider: {} });
    const failSigning = async () => {
      await f.store.transaction(tx => tx.write('imd-payments', 'offer-1', { id: 'offer-1', offerId: 'offer-1',
        state: 'signing_unknown', sealedIntent: 'local-only' }, 0));
    };
    if (resumed) await failSigning();
    const result = await f.flow.runPaid({ createPayment: () => ({ ...payment,
      prepare: async () => { await failSigning(); throw Object.assign(Error('local signing failure'), { code: 'payment_signing_unknown' }); } }) });
    assert.equal(result.state, 'blocked');
    assert.equal((await payment.status('offer-1')).state, 'cancelled');
    assert.equal((await f.flow.admission.get(f.actor)).committedMaximum, '0');
    const balance = await f.network.billing.balance({ actor: f.workerActor, account: 'sponsor:' + f.ownerAddress, asset: f.asset });
    assert.equal(balance.reserved, '0'); assert.equal(balance.available, '50');
    assert.equal((await f.flow.runPaid({ createPayment: () => payment })).idle, true);
  }
});
