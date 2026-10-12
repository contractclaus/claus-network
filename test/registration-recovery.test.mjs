import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData } from 'viem';
import { openStore } from '../src/storage/index.mjs';
import { canonical, digest } from '../src/shared/index.mjs';
import { createChainExecutor } from '../adapters/chain-executor.mjs';
import { ClausApprovalExecutorAbi } from '../adapters/chain-abi.mjs';
import { createJobs } from '../src/jobs/index.mjs';
import { createChainDeployments } from '../src/chain-deployments/index.mjs';
import { createApprovals } from '../src/approvals/index.mjs';

const address = digit => '0x' + digit.repeat(40), hash = digit => '0x' + digit.repeat(64);
async function fixture(t) {
  const store = openStore(':memory:'); t.after(() => store.close());
  const value = { id: 'registration', projectId: 'project', moduleId: 'module', chainId: 11155111,
    executor: address('1'), observedBlock: '100', configuration: '0x1234', message: {
      projectId: hash('2'), owner: address('3'), salt: hash('4'), implementation: address('5'),
      codeHash: hash('6'), initCallHash: hash('7'), mandateHash: hash('8'), policyVersion: hash('9'),
      minDelaySeconds: 0, expiresAt: 2000, nonce: '0' } };
  const signature = '0x1234';
  const data = encodeFunctionData({ abi: ClausApprovalExecutorAbi, functionName: 'registerProject',
    args: [value.message, value.configuration, signature] });
  let height = 90n, timestamp = 1800n, eventBlock = 101n, transactionData = data, registered = true;
  const project = [value.message.owner, address('a'), value.message.mandateHash, value.message.policyVersion, 0n];
  const log = { transactionHash: hash('b'), blockHash: hash('c'), args: {
    owner: value.message.owner, target: project[1], mandateHash: value.message.mandateHash } };
  const client = {
    getBlock: async ({ blockNumber }) => ({ number: blockNumber ?? height, timestamp, hash: hash('c') }),
    getBlockNumber: async () => height + 64n,
    getLogs: async ({ fromBlock, toBlock }) => registered && fromBlock <= eventBlock && toBlock >= eventBlock ? [log] : [],
    getTransactionReceipt: async () => ({ status: 'success', blockNumber: eventBlock,
      blockHash: log.blockHash, transactionHash: log.transactionHash }),
    getTransaction: async () => ({ to: value.executor, input: transactionData }),
    getCode: async () => '0x1234',
    readContract: async ({ functionName, blockNumber }) => {
      if (functionName === 'projects') return blockNumber !== undefined && blockNumber < eventBlock ? [address('0'), address('0')] : project;
      if (functionName === 'executor') return value.executor;
      if (functionName === 'projectId') return value.message.projectId;
      assert.fail(functionName);
    }
  };
  await store.transaction(async tx => {
    await tx.write('network-capabilities', 'chain', { enabled: true, profile: 'claus-readonly-v1',
      executor: value.executor, artifactProjectId: 'core', targetArtifactHash: hash('d') }, 0);
    await tx.write('chain-modules', value.moduleId, { receipt: { blockNumber: '80' } }, 0);
  });
  const executor = createChainExecutor({ store, client, signer: { address: address('e') }, now: () => 2100000,
    chain: { capabilityMatches: async () => {}, verifyRegistration: async () => true },
    artifacts: { get: async () => ({}) }, verification: { step: async () => ({ state: 'verified' }) } });
  return { store, value, project, log, client,
    step: () => executor.deployment.step({ kind: 'project-register', value, signature, authorize: async () => true }),
    finalize: (number, time = 1900n) => { height = number; timestamp = time; },
    earlier: (block = 85n) => { eventBlock = block; },
    omitEvent: () => { registered = false; },
    restoreEvent: () => { registered = true; },
    padInput: () => { transactionData += '00'.repeat(32); },
    changeInput: () => { transactionData = '0x12345678'; }
  };
}

test('a mined relay without finalized logs is serializable and remains recoverable after signature expiry', async t => {
  const f = await fixture(t);
  const pending = await f.step();
  assert.equal(pending.state, 'registering');
  assert.doesNotThrow(() => canonical(pending));
  assert.equal(Object.hasOwn(pending, 'transactionHash'), false);
  f.finalize(110n, 2100n);
  const complete = await f.step();
  assert.equal(complete.state, 'verified');
  assert.equal(complete.binding.registrationTransaction, f.log.transactionHash);
  assert.equal((await f.store.list('chain-transactions')).length, 0);
});

test('an earlier relay is found before the current intent observation block', async t => {
  const f = await fixture(t); f.earlier(); f.finalize(110n);
  assert.equal((await f.step()).state, 'verified');
});

test('a different signed registration cannot be adopted from a matching project event', async t => {
  const f = await fixture(t); f.finalize(110n); f.changeInput();
  await assert.rejects(f.step(), { code: 'registered_project_mismatch' });
});

test('one empty RPC log page cannot permanently skip a valid relay', async t => {
  const f = await fixture(t); f.omitEvent(); f.finalize(110n);
  await assert.rejects(f.step(), { code: 'recovery_logs_inconsistent' });
  assert.equal((await f.store.list('chain-event-recovery')).length, 0);
  f.restoreEvent();
  assert.equal((await f.step()).state, 'verified');
});

test('a registration before this module existed remains a terminal conflict', async t => {
  const f = await fixture(t); f.earlier(70n); f.finalize(110n);
  await assert.rejects(f.step(), { code: 'registered_project_mismatch' });
});

test('a padded direct relay still represents the same signed registration', async t => {
  const f = await fixture(t); f.finalize(110n); f.padInput();
  assert.equal((await f.step()).state, 'verified');
});

test('a local deadline cannot close recovery while finalized chain time is earlier', async t => {
  const f = await fixture(t), read = f.client.readContract;
  f.client.readContract = input => input.functionName === 'projects' && input.blockNumber === undefined ?
    [address('0'), address('0')] : read(input);
  assert.equal((await f.step()).state, 'registering');
  f.client.readContract = read; f.finalize(110n, 1990n);
  assert.equal((await f.step()).state, 'verified');
});

test('post-receipt state reads are pinned and transient missing state is retryable', async t => {
  const f = await fixture(t); f.finalize(110n);
  const read = f.client.readContract; let lag = true;
  f.client.readContract = input => {
    if (input.functionName === 'projects' && input.blockNumber === 101n && lag)
      return [address('0'), address('0')];
    if (['executor', 'projectId'].includes(input.functionName)) assert.equal(input.blockNumber, 101n);
    return read(input);
  };
  await assert.rejects(f.step(), { code: 'registration_state_unavailable' });
  lag = false;
  assert.equal((await f.step()).state, 'verified');
});

test('a missing finalized registration past its deadline terminates without a new transaction', async t => {
  const f = await fixture(t); f.finalize(90n, 2100n);
  assert.deepEqual(await f.step(), { state: 'blocked', error: 'authority_or_window_closed' });
  assert.equal((await f.store.list('chain-transactions')).length, 0);
});

async function workerFixture(t, kind) {
  const store = openStore(':memory:'); t.after(() => store.close());
  let clock = 1800000000000;
  const identity = { authorize: async () => {} }, now = () => clock;
  const jobs = createJobs({ store, identity, now });
  const registration = kind === 'project-register', id = 'work', projectId = 'project';
  const collection = registration ? 'chain-registrations' : 'chain-proposals';
  await store.transaction(async tx => {
    await tx.write('network-capabilities', 'chain', { enabled: true, chainId: 11155111 }, 0);
    await tx.write('review-pilots', projectId, { enabled: true, expiresAt: clock + 86400000 }, 0);
    await tx.write(collection, id, { id, projectId, moduleId: 'module', state: 'queued', caseId: 'case', reviewArtifactHash: 'report' }, 0);
    await tx.write('chain-registration-signatures', id, { signature: 'fixture' }, 0);
    await tx.write('review-cases', 'case', { state: 'reviewed', artifactHash: 'report', input: { sourceHash: 'source' } }, 0);
    await tx.write('public-sources', digest({ projectId, id: 'source' }), { published: true }, 0);
    await jobs.enqueue(tx, { projectId, kind, payload: registration ? { registrationId: id } : { proposalId: id },
      authority: { actor: 'fixture-agent' }, idempotencyKey: id });
  });
  const artifacts = { get: async () => ({ evidence: { chain: {} } }) };
  const deployments = createChainDeployments({ store, identity, jobs, artifacts, now });
  const approvals = createApprovals({ store, identity, jobs, artifacts, deployments, now });
  return { store, collection, advance: () => { clock += 61000; }, run: worker => registration ? deployments.runOne(worker) :
    kind === 'claus-review' ? approvals.runDecision(worker) : approvals.runExecution(worker) };
}

for (const kind of ['project-register', 'protected-execute', 'claus-review']) {
  test(`${kind} catches asynchronous persistence errors and retains the original job`, async t => {
    const f = await workerFixture(t, kind);
    const result = await f.run({ step: async () => ({ state: 'waiting', invalid: undefined }) });
    assert.equal(result.state, 'waiting');
    assert.equal(result.result.error, 'invalid_json');
    assert.equal((await f.store.list('workflow-jobs')).length, 1);
  });
}

for (const kind of ['project-register', 'protected-execute']) {
  test(`${kind} makes finalized recovery conflicts terminal during reconciliation`, async t => {
    const f = await workerFixture(t, kind);
    await f.run({ step: async () => ({ state: 'waiting' }) }); f.advance();
    const result = await f.run({ step: async () => { throw Object.assign(Error('conflict'), { code: 'recovery_block_changed' }); } });
    assert.equal(result.state, 'blocked');
    assert.equal((await f.store.read(f.collection, 'work')).value.state, 'blocked');
    f.advance();
    assert.equal((await f.run({ step: async () => assert.fail('terminal job ran again') })).idle, true);
  });
}

test('a different registered project permanently blocks its original queued registration', async t => {
  const f = await workerFixture(t, 'project-register');
  await f.run({ step: async () => ({ state: 'registering' }) }); f.advance();
  const result = await f.run({ step: async () => { throw Object.assign(Error('mismatch'), { code: 'registered_project_mismatch' }); } });
  assert.equal(result.state, 'blocked');
  assert.equal((await f.store.read(f.collection, 'work')).value.error, 'registered_project_mismatch');
});

test('a temporarily unavailable post-registration state keeps the same job recoverable', async t => {
  const f = await workerFixture(t, 'project-register');
  const result = await f.run({ step: async () => { throw Object.assign(Error('lag'), { code: 'registration_state_unavailable' }); } });
  assert.equal(result.state, 'waiting'); f.advance();
  const complete = await f.run({ step: async () => ({ state: 'verified', binding: { target: address('a') } }) });
  assert.equal(complete.state, 'complete');
  assert.equal((await f.store.read('chain-bindings', 'project')).value.target, address('a'));
});
