import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { openStore } from '../src/storage/index.mjs';
import { createApplication } from '../runtime/server.mjs';
import { createClient } from '../interfaces/sdk.mjs';
import { digest } from '../src/shared/index.mjs';

test('a restarted API client can read publication revisions and withdraw without overwriting concurrent changes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claus-publication-'));
  let store, app;
  const reopen = async () => {
    if (store) await store.close();
    store = openStore(join(dir, 'state.sqlite'));
    app = createApplication({ store, rateSalt: 'local-publication-recovery-fixture' });
  };
  t.after(async () => { await store?.close(); await rm(dir, { recursive: true, force: true }); });
  await reopen();
  const client = token => createClient({ origin: 'https://claus.si', token,
    fetch: (url, init) => app.fetch(new Request(url, init)) });
  const account = privateKeyToAccount(generatePrivateKey());
  const challenge = await client().call('auth_challenge', { address: account.address });
  const session = await client().call('auth_session', { challengeId: challenge.id,
    signature: await account.signMessage({ message: challenge.message }) });
  let owner = client(session.token);
  const project = await owner.call('project_create', { slug: 'publication-recovery', name: 'Publication recovery', idempotencyKey: 'once' });
  const projectId = project.id;
  const source = await owner.call('snapshot_create', { projectId, expectedProjectRevision: (await owner.call('project_get', { projectId })).revision,
    files: [{ path: 'Source.sol', content: 'pragma solidity ^0.8.27; contract Source {}' }] });
  const caseId = digest('local-review'), proposalId = digest('local-proposal');
  await store.transaction(async tx => {
    await tx.write('review-cases', caseId, { id: caseId, projectId, state: 'reviewed', artifactHash: digest('local-report'),
      providerJobId: 'local-job', quoteJobId: 'local-quote-job', input: { sourceHash: source.id,
        buildHash: digest('local-build'), repoUrl: 'https://github.com/example/local-fixture', baseCommit: 'a'.repeat(40) } }, 0);
    const inputArtifactHash = await app.artifacts.put(tx, projectId, { source: { snapshotHash: source.id } });
    await tx.write('chain-proposals', proposalId, { id: proposalId, projectId, state: 'rejected', inputArtifactHash,
      proposalHash: digest('local-proposal'), decision: { decision: 'reject', reason: 'local fixture', risks: [],
        decisionHash: digest('local-decision'), configurationRevision: 1, model: 'local-fixture', completedAt: Date.now() } }, 0);
  });
  const cases = [
    { get: 'project_get', put: 'project_publish', args: { projectId } },
    { get: 'snapshot_get', put: 'source_publish', args: { projectId, snapshotId: source.id } },
    { get: 'review_get', put: 'review_publish', args: { projectId, caseId } },
    { get: 'proposal_get', put: 'proposal_publish', args: { projectId, proposalId } }
  ];
  for (const c of cases) {
    const current = await owner.call(c.get, c.args);
    assert.equal(current.publication?.published, false, c.get);
    assert.equal(current.publication.revision, 0, c.get);
    await owner.call(c.put, { ...c.args, published: true, expectedRevision: current.publication.revision });
  }
  await reopen(); owner = client(session.token);
  // The new client retains its credential and identifiers, but none of the PUT responses.
  for (const c of cases.toReversed()) {
    const current = await owner.call(c.get, c.args);
    assert.equal(current.publication.published, true, c.get);
    assert.equal(current.publication.revision, 1, c.get);
    await owner.call(c.put, { ...c.args, published: false, expectedRevision: current.publication.revision });
    await assert.rejects(owner.call(c.put, { ...c.args, published: false, expectedRevision: current.publication.revision }), { code: 'revision_conflict' });
    const withdrawn = await owner.call(c.get, c.args);
    assert.equal(withdrawn.publication.published, false, c.get);
    assert.equal(withdrawn.publication.revision, 2, c.get);
    await assert.rejects(client().call(c.get, c.args), { code: 'unauthenticated' });
  }
  const agent = await owner.call('agent_create', { projectId, name: 'Scoped reader' });
  const mandate = await owner.call('mandate_create', { projectId, principalId: agent.id,
    scopes: ['project.read'], expiresAt: Date.now() + 60000 });
  const credential = await owner.call('credential_create', { mandateId: mandate.id });
  const reader = client(credential.token);
  assert.equal((await reader.call('project_get', { projectId })).publication.revision, 2);
  await assert.rejects(reader.call('snapshot_get', cases[1].args), { code: 'scope_denied' });
  await owner.call('mandate_revoke', { mandateId: mandate.id });
  await assert.rejects(reader.call('project_get', { projectId }), { code: 'scope_denied' });
});
