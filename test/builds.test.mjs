import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/storage/index.mjs';
import { createApplication } from '../runtime/server.mjs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

async function fixture(t) {
  const store = openStore(':memory:'); t.after(() => store.close());
  const app = createApplication({ store, rateSalt: 'x'.repeat(32) });
  const account = privateKeyToAccount(generatePrivateKey());
  const challenge = await app.identity.challenge({ address: account.address });
  const session = await app.identity.session({ challengeId: challenge.id, signature: await account.signMessage({ message: challenge.message }) });
  const actor = await app.identity.authenticate(session.token);
  const project = await app.identity.createProject(actor, { name: 'Compile', slug: 'compile-test', idempotencyKey: 'one' });
  const snapshot = await app.projects.createSnapshot(actor, project.id, { files: [{ path: 'A.sol', content: 'contract A {}' }], expectedProjectRevision: 1 });
  return { ...app, store, actor, projectId: project.id, input: { snapshotId: snapshot.id, entry: 'A.sol', contract: 'A', idempotencyKey: 'compile-one' } };
}

test('durable compilation deduplicates admission and stores large artifacts without publication', async t => {
  const f = await fixture(t);
  const build = await f.builds.submit(f.actor, f.projectId, f.input);
  assert.deepEqual(await f.builds.submit(f.actor, f.projectId, f.input), build);
  await assert.rejects(f.builds.submit(f.actor, f.projectId, { ...f.input, contract: 'Other' }), { code: 'idempotency_conflict' });
  let called = 0;
  await f.builds.runOne(async input => {
    called++; assert.equal(input.files[0].content, 'contract A {}');
    return { status: 'compiled', evidenceLevel: 'compiled_only', standardInput: { source: 'source'.repeat(22000) } };
  });
  assert.equal(called, 1);
  const artifact = await f.builds.artifact(f.actor, f.projectId, build.id);
  assert.equal(artifact.standardInput.source.length, 132000);
  assert.equal((await f.jobs.get(f.actor, f.projectId, build.id)).state, 'complete');
  assert.equal((await f.projects.graph()).nodes.length, 1);
  assert.equal((await f.builds.runOne(() => { throw Error('should not run'); })).idle, true);
});

test('a revoke during compilation prevents committing the result', async t => {
  const f = await fixture(t);
  const agent = await f.identity.createAgent(f.actor, f.projectId, { name: 'Compiler' });
  const mandate = await f.identity.grant(f.actor, f.projectId, { principalId: agent.id,
    scopes: ['build.compile', 'artifact.read'], expiresAt: Date.now() + 60000 });
  const key = await f.identity.issueCredential(f.actor, { mandateId: mandate.id });
  const actor = await f.identity.authenticate(key.token);
  const build = await f.builds.submit(actor, f.projectId, f.input);
  await f.builds.runOne(async () => {
    await f.identity.revoke(f.actor, 'mandate', mandate.id);
    return { status: 'compiled', code: 'not committed' };
  });
  const result = await f.builds.get(f.actor, f.projectId, build.id);
  assert.equal(result.error, 'authorization_revoked'); assert.equal(result.artifactHash, null);
  assert.equal((await f.jobs.get(f.actor, f.projectId, build.id)).state, 'blocked');
});

test('cancelling queued compilation releases project admission without executing code', async t => {
  const f = await fixture(t);
  const build = await f.builds.submit(f.actor, f.projectId, f.input);
  await assert.rejects(f.builds.submit(f.actor, f.projectId, { ...f.input, idempotencyKey: 'two' }), { code: 'build_in_progress' });
  await f.jobs.cancel(f.actor, f.projectId, build.id);
  assert.equal((await f.builds.get(f.actor, f.projectId, build.id)).state, 'cancelled');
  assert.equal((await f.builds.submit(f.actor, f.projectId, f.input)).state, 'cancelled');
  const next = await f.builds.submit(f.actor, f.projectId, { ...f.input, idempotencyKey: 'two' });
  assert.notEqual(next.id, build.id);
  const result = await f.builds.runOne(async () => ({ status: 'rejected', errors: [{ code: 'syntax' }] }));
  assert.equal(result.state, 'failed');
});

test('compiler selection is durable and cannot be changed under an existing request key', async t => {
  const f = await fixture(t), compilerProfile = 'solidity-0.8.26-static-v1';
  const build = await f.builds.submit(f.actor, f.projectId, { ...f.input, compilerProfile });
  assert.equal(build.compilerProfile, compilerProfile);
  assert.notEqual(build.id, build.jobId);
  assert.equal((await f.jobs.claim({ kinds: ['compile'], leaseMs: 120000 })).idle, true);
  await assert.rejects(f.builds.submit(f.actor, f.projectId, f.input), { code: 'idempotency_conflict' });
  const restarted = createApplication({ store: f.store, rateSalt: 'x'.repeat(32) });
  await restarted.builds.runOne(async input => {
    assert.equal(input.compilerProfile, compilerProfile);
    return { status: 'compiled', profile: { profile: compilerProfile } };
  });
  assert.equal((await f.builds.artifact(f.actor, f.projectId, build.id)).profile.profile, compilerProfile);
});

test('new-profile cancellation is visible through the stable build ID and does not leak admission', async t => {
  const f = await fixture(t);
  const build = await f.builds.submit(f.actor, f.projectId, { ...f.input, compilerProfile: 'solidity-0.8.26-static-v1' });
  await f.jobs.cancel(f.actor, f.projectId, build.jobId);
  assert.equal((await f.builds.get(f.actor, f.projectId, build.id)).state, 'cancelled');
  const next = await f.builds.submit(f.actor, f.projectId, { ...f.input, idempotencyKey: 'next' });
  assert.notEqual(next.id, build.id);
});

test('explicit default compiler reuses old requests and unsupported compilers never enter the queue', async t => {
  const f = await fixture(t);
  await assert.rejects(f.builds.submit(f.actor, f.projectId, { ...f.input, compilerProfile: 'latest' }),
    { code: 'unsupported_compiler_profile' });
  const build = await f.builds.submit(f.actor, f.projectId, f.input);
  assert.equal(build.compilerProfile, undefined);
  assert.deepEqual(await f.builds.submit(f.actor, f.projectId, { ...f.input, compilerProfile: 'solidity-static-compile-v1' }), build);
});
