import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPublicClient, createWalletClient, http, encodeAbiParameters, decodeAbiParameters, keccak256 } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createApplication } from '../runtime/server.mjs';
import { createChainRead } from '../adapters/chain-read.mjs';
import { createChainExecutor } from '../adapters/chain-executor.mjs';
import { createClausController } from '../adapters/claus-controller.mjs';
import { createSealer } from '../adapters/secrets.mjs';
import { compileSnapshot } from '../adapters/compiler.mjs';
import { openStore } from '../src/storage/index.mjs';
import { digest } from '../src/shared/index.mjs';

test('API project, real signatures, contract queue and delayed execution work across isolated roles',
  { skip: !process.env.CLAUS_TEST_CHAIN, timeout: 90000 }, async t => {
  const url = new URL(process.env.CLAUS_TEST_CHAIN);
  assert.equal(url.hostname, '127.0.0.1', 'This fixture must never use a public chain');
  const client = createPublicClient({ transport: http(url.href, { retryCount: 0 }), cacheTime: 0 });
  assert.equal(await client.getChainId(), 11155111);
  await client.request({ method: 'anvil_reset', params: [] });
  const owner = privateKeyToAccount(generatePrivateKey()), payer = privateKeyToAccount(generatePrivateKey()), approval = privateKeyToAccount(generatePrivateKey());
  for (const account of [owner, payer]) await client.request({ method: 'anvil_setBalance', params: [account.address, '0x56bc75e2d63100000'] });
  const wallet = createWalletClient({ account: owner, transport: http(url.href) });
  const contract = async name => JSON.parse(await readFile(new URL('../contracts/out/' + name + '.sol/' + name + '.json', import.meta.url)));
  const executorSource = await contract('ClausApprovalExecutor');
  const deployHash = await wallet.deployContract({ chain: null, abi: executorSource.abi, bytecode: executorSource.bytecode.object,
    args: [approval.address, owner.address, 86400n] });
  const executorAddress = (await client.waitForTransactionReceipt({ hash: deployHash })).contractAddress;
  const store = openStore(':memory:'); t.after(() => store.close());
  let clock = Number((await client.getBlock({blockTag: 'latest'})).timestamp) * 1000;
  const chain = createChainRead({ client });
  const app = createApplication({ store, now: () => clock, rateSalt: 'test-only'.repeat(8), chainPorts: { chain } });
  const challenge = await app.identity.challenge({ address: owner.address });
  const session = await app.identity.session({ challengeId: challenge.id, signature: await owner.signMessage({ message: challenge.message }) });
  const ownerActor = await app.identity.authenticate(session.token);
  const project = await app.identity.createProject(ownerActor, { name: 'Local fixture', slug: 'local-fixture', idempotencyKey: 'first' });
  const agent = await app.identity.createAgent(ownerActor, project.id, { name: 'Local agent' });
  const mandate = await app.identity.grant(ownerActor, project.id, { principalId: agent.id, expiresAt: clock + 7 * 86400000,
    scopes: ['project.read', 'artifact.read', 'artifact.write', 'snapshot.create', 'build.compile', 'review.read',
      'proposal.create', 'proposal.read', 'proposal.execute', 'source.publish', 'project.publish', 'job.cancel'] });
  const credential = await app.identity.issueCredential(ownerActor, { mandateId: mandate.id });
  const actor = await app.identity.authenticate(credential.token);
  const path = 'src/ClausBalanceLens.sol', content = await readFile(new URL('../contracts/src/ClausBalanceLens.sol', import.meta.url), 'utf8');
  const snapshot = await app.projects.createSnapshot(actor, project.id, { files: [{ path, content }], expectedProjectRevision: 1 });
  await app.projects.publishSource(actor, project.id, { snapshotId: snapshot.id, expectedRevision: 0, published: true });
  const build = await app.builds.submit(actor, project.id, { snapshotId: snapshot.id, entry: path, contract: 'ClausBalanceLens', idempotencyKey: 'compile' });
  await app.builds.runOne(compileSnapshot);
  const compiled = await app.builds.get(actor, project.id, build.id); assert.equal(compiled.state, 'compiled');
  const caseId = digest({ fixture: project.id });
  await store.transaction(async tx => {
    const reportHash = await app.artifacts.put(tx, project.id, { complete: true, jobId: 'local-review', report: 'Local test report, not an independent audit.' });
    const targetArtifactHash = await app.artifacts.put(tx, project.id, { contract: 'ClausReadonlyProject' });
    await tx.write('review-cases', caseId, { id: caseId, projectId: project.id, buildId: build.id, state: 'reviewed',
      artifactHash: reportHash, providerJobId: 'local-review', quoteJobId: 'fixture-review-done', quoteId: null, reviewJobId: null,
      input: { repoUrl: 'https://github.com/example/local-fixture', baseCommit: 'a'.repeat(40), contracts: [path],
        sourceHash: snapshot.id, buildHash: compiled.artifactHash } }, 0);
    await tx.write('review-pilots', project.id, { enabled: true, expiresAt: clock + 7 * 86400000 }, 0);
    await tx.write('network-capabilities', 'chain', { enabled: true, profile: 'claus-readonly-v1', chainId: 11155111,
      executor: executorAddress, executorCodeHash: keccak256(await client.getCode({ address: executorAddress })),
      approvalSigner: approval.address, executorPayer: payer.address, artifactProjectId: project.id, targetArtifactHash }, 0);
  });
  const executor = createChainExecutor({ store, client, signer: payer, chain, artifacts: app.artifacts, now: () => clock,
    sealer: createSealer('22'.repeat(32)), verification: { step: async input => ({ state: 'verified', localFixture: true, address: input.address }) } });
  async function advance(seconds = 31) {
    await client.request({ method: 'evm_increaseTime', params: [seconds] });
    await client.request({ method: 'anvil_mine', params: ['0x3', '0x1'] });
    clock = Number((await client.getBlock({blockTag: 'latest'})).timestamp) * 1000;
  }
  async function until(step, read, state, rounds = 10) {
    for (let i = 0; i < rounds; i++) {
      await step(); const value = await read(); if (value.state === state) return value;
      if (['failed', 'blocked'].includes(value.state)) assert.fail(JSON.stringify(value));
      await advance();
    }
    assert.fail(JSON.stringify({ value: await read(), jobs: (await store.list('workflow-jobs', {limit: 100})).map(x => ({kind:x.value.kind, state:x.value.state, result:x.value.result})) }));
  }
  const module = await app.deployments.deployModule(actor, project.id, { caseId });
  const deployed = await until(() => app.deployments.runOne(executor.deployment),
    () => app.deployments.module(actor, project.id, module.id), 'verified');
  assert.equal((await app.deployments.deployModule(actor, project.id, { caseId })).id, module.id);
  const balanceArtifact = await compileSnapshot({ files: [{ path: 'Balance.sol', content: 'pragma solidity 0.8.27; contract Balance { function balanceOf(address) external pure returns(uint256) { return 23; } }' }], entry: 'Balance.sol', contract: 'Balance' });
  const balanceHash = await wallet.deployContract({ chain: null, abi: balanceArtifact.abi, bytecode: balanceArtifact.creationBytecode });
  const balanceAddress = (await client.waitForTransactionReceipt({ hash: balanceHash })).contractAddress;
  const configuration = encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [balanceAddress, balanceAddress]);
  const registration = await app.deployments.prepareRegistration(ownerActor, project.id, { moduleId: deployed.id,
    configuration, mandateId: mandate.id, minDelaySeconds: 3600 });
  const signature = await owner.signTypedData({ domain: registration.domain, types: registration.types,
    primaryType: registration.primaryType, message: registration.message });
  await app.deployments.submitRegistration(actor, project.id, { registrationId: registration.id, signature });
  await until(() => app.deployments.runOne(executor.deployment),
    () => app.deployments.registration(actor, project.id, registration.id), 'verified');
  const proposal = await app.approvals.create(actor, project.id, { moduleId: deployed.id, configuration, idempotencyKey: 'upgrade' });
  let calls = 0;
  const controller = createClausController({ store, chain, client, signer: approval, secret: 'local-test', now: () => clock,
    fetcher: async (url, options) => {
      if (options.method === 'GET') return Response.json({ error: 'not_found' }, { status: 404 });
      calls++; const input = JSON.parse(options.body);
      const result = { decision: 'approve', reason: 'Local fixture approves this exact non-custodial change.', risks: ['Local fixture only'],
        inputHash: digest(input), proposalHash: input.proposalHash, reviewArtifactHash: input.review.artifactHash,
        configurationRevision: 1, configurationHash: digest('local'), model: 'local-fixture', completedAt: new Date(clock).toISOString(), inferenceReceipt: null };
      return Response.json({ id: 'nr_' + digest(input).slice(7), state: 'completed', result: { ...result, decisionHash: digest(result) } });
    } });
  assert.equal((await app.approvals.runDecision(controller)).state, 'complete'); assert.equal(calls, 1);
  const approved = await app.approvals.get(actor, project.id, proposal.id); assert.equal(approved.state, 'approved');
  const input = await app.artifacts.get(project.id, approved.inputArtifactHash);
  await assert.rejects(controller.step({ value: approved, input: { ...input, proposal: { ...input.proposal, nonce: '0' } }, authorize: async () => true }), { code: 'decision_input_mismatch' });
  const queued = await until(() => app.approvals.runExecution(executor.execution),
    () => app.approvals.get(actor, project.id, proposal.id), 'queued');
  assert(queued.readyAt > Math.floor(clock / 1000));
  await advance(3700);
  const completed = await until(() => app.approvals.runExecution(executor.execution),
    () => app.approvals.get(actor, project.id, proposal.id), 'executed');
  const target = completed.execution.address;
  const targetAbi = (await contract('ClausReadonlyProject')).abi;
  const encoded = await client.readContract({ address: target, abi: targetAbi, functionName: 'evaluate',
    args: [encodeAbiParameters([{ type: 'address' }], [owner.address])] });
  const result = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' },
    { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }], encoded);
  assert.equal(result[0], 11155111n); assert.equal(result[4], 23n); assert.equal(result[6], 23n);
  assert.equal(completed.execution.version, 2);
  await app.approvals.publish(actor, project.id, { proposalId: proposal.id, published: true, expectedRevision: 0 });
  await app.projects.publish(actor, project.id, { published: true, expectedRevision: 0 });
  const publicProject = await app.projects.publicProject(project.slug);
  assert.equal(publicProject.evidence.deployments[0].transactionHash, completed.execution.transactionHash);
  assert.equal(publicProject.evidence.deployments[0].verification, 'verified');
  assert.equal('inferenceReceipt' in publicProject.evidence.decisions[0], false);
  const count = (await store.list('chain-transactions', {limit: 100})).length;
  await assert.rejects(executor.execution.step({value: {...approved, decision: {...approved.decision, decisionHash: digest('tampered')}},
    authorize: async () => true}), {code: 'approval_missing'});
  assert.equal((await store.list('chain-transactions', {limit: 100})).length, count);
  const cancelled = await app.approvals.create(actor, project.id, {moduleId: deployed.id, configuration, idempotencyKey: 'cancelled-upgrade'});
  await app.jobs.cancel(actor, project.id, cancelled.decisionJobId);
  assert.equal((await app.approvals.get(actor, project.id, cancelled.id)).state, 'cancelled');
  const stale = await app.approvals.create(actor, project.id, {moduleId: deployed.id, configuration, idempotencyKey: 'stale-upgrade'});
  await app.approvals.runDecision(controller);
  await until(() => app.approvals.runExecution(executor.execution),
    () => app.approvals.get(actor, project.id, stale.id), 'queued');
  const revokeHash = await wallet.writeContract({chain: null, address: executorAddress, abi: executorSource.abi,
    functionName: 'setAuthority', args: [stale.proposal.projectKey, stale.proposal.mandateHash, false]});
  await client.waitForTransactionReceipt({hash: revokeHash});
  await advance(3700);
  assert.equal((await app.approvals.runExecution(executor.execution)).state, 'blocked');
  assert.equal((await app.approvals.get(actor, project.id, stale.id)).state, 'blocked');
  assert.equal(await store.read('chain-transactions', 'execute:' + stale.id), null);
  const restoreHash = await wallet.writeContract({chain: null, address: executorAddress, abi: executorSource.abi,
    functionName: 'setAuthority', args: [stale.proposal.projectKey, stale.proposal.mandateHash, true]});
  await client.waitForTransactionReceipt({hash: restoreHash});
  const next = await app.approvals.create(actor, project.id, {moduleId: deployed.id, configuration, idempotencyKey: 'revoked-upgrade'});
  const freshChallenge = await app.identity.challenge({address: owner.address});
  const freshSession = await app.identity.session({challengeId: freshChallenge.id, signature: await owner.signMessage({message: freshChallenge.message})});
  await app.identity.revoke(await app.identity.authenticate(freshSession.token), 'mandate', mandate.id);
  assert.equal((await app.approvals.runDecision(controller)).state, 'blocked');
  assert.equal(calls, 2, 'revocation blocks a fresh paid decision');
  assert.equal(await store.read('claus-signed-approvals', next.id), null);
});
