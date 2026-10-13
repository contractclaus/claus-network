import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/storage/index.mjs';
import { createJobs } from '../src/jobs/index.mjs';
import { createContractIntake, bindingWord, intakeProposalId } from '../src/contract-intake/index.mjs';
import { digest, requireThat } from '../src/shared/index.mjs';

const word = n => '0x' + n.repeat(64), address = n => '0x' + n.repeat(40);
async function fixture(t, chainId = 11155111) {
  const f = { time: 1800000000000, enabled: true, allowedProjects: ['project-a'], revoked: false, pending: true, submissions: 0, proposals: new Map() };
  f.store = openStore(':memory:'); t.after(() => f.store.close());
  const identity = { credential: async actor => ({ kind: actor, expiresAt: f.time + 2 * 86400000 }), async authorize(actor, _action, { projectId }) {
    requireThat(!f.authExpired, 'unauthenticated');
    requireThat((actor === 'owner' || actor === 'agent' && !f.revoked) && projectId === 'project-a', 'scope_denied');
  } };
  const profile = { chainId, inbox: address('a'), codeHash: word('1'), capability: word('2') };
  const chain = { profile: async () => profile, observe: async () => structuredClone(f.observation), pending: async () => f.pending };
  f.open = () => {
    f.jobs = createJobs({ store: f.store, identity, now: () => f.time, onCancel: (tx, job) => f.api.onCancel(tx, job) });
    f.api = createContractIntake({ store: f.store, identity, jobs: f.jobs, chain, now: () => f.time,
      enabled: (_reader, projectId) => f.enabled && f.allowedProjects.includes(projectId),
      readProposal: async (_project, id) => f.proposals.get(id),
      createProposal: async (_actor, projectId, input) => {
        if (f.capacityError) throw f.capacityError;
        f.submissions++;
        const { idempotencyKey, ...body } = input;
        const id = digest({ projectId, idempotencyKey, kind: 'protected-upgrade' });
        const p = { id, projectId, requestHash: digest(body) };
        f.proposals.set(id, p);
        if (f.loseResponse) throw Error('response lost after creation');
        return p;
      } });
  };
  f.open();
  if (chainId !== 11155111) await f.store.transaction(tx => tx.write('chain-bindings', 'project-a', { chainId }, 0));
  f.bindingBody = { requester: address('b'), expiresAt: f.time + 86400000, maxRequests: 2, idempotencyKey: 'first' };
  f.binding = await f.api.bind('agent', 'project-a', f.bindingBody);
  f.observation = { ...profile, finalized: true, state: 'pending', requestId: word('3'),
    binding: bindingWord(f.binding.id), requester: address('b'), deadline: Math.floor(f.time / 1000) + 3600,
    input: { moduleId: 'reviewed-module', configuration: '0x1234' }, callbackGas: 200000,
    blockNumber: 100, blockHash: word('4'), transactionHash: word('5'), logIndex: 0 };
  f.ingest = () => f.api.ingest(f.binding.id, { transactionHash: word('5'), logIndex: 0 });
  f.advance = () => { f.time += 60001; };
  f.decide = request => {
    const id = intakeProposalId('project-a', request.id), p = f.proposals.get(id);
    p.decision = { decision: 'approve', decisionHash: digest({ fixture: 'decision' }), reason: 'private review not sent onchain' };
  };
  return f;
}

test('replayed events and lost responses keep one proposal and a minimal public result', async t => {
  const f = await fixture(t), request = await f.ingest();
  assert.deepEqual(await f.ingest(), request);
  assert.equal((await f.api.binding('agent', 'project-a', f.binding.id)).used, 1);
  f.loseResponse = true; await f.api.run();
  assert.equal(f.submissions, 1);
  f.open(); f.advance(); f.decide(request); f.revoked = true;
  await f.api.run();
  assert.equal(f.submissions, 1);
  const status = await f.api.request('owner', 'project-a', request.id);
  assert.equal(status.state, 'result_ready');
  assert.equal(status.result.decision, 'approve');
  assert.equal(status.result.reason, undefined);
  assert.equal(status.observation, undefined);
});

test('binding revocation or chain cancellation before dispatch prevents a proposal', async t => {
  for (const mode of ['binding', 'credential', 'chain']) {
    const f = await fixture(t), request = await f.ingest();
    if (mode === 'binding') await f.api.revoke('owner', 'project-a', f.binding.id);
    if (mode === 'credential') f.revoked = true;
    if (mode === 'chain') f.pending = false;
    await f.api.run();
    assert.equal(f.submissions, 0);
    assert.equal((await f.api.request('owner', 'project-a', request.id)).state, 'blocked');
  }
});

test('a finalized event can be reconciled after its deadline without new work', async t => {
  const f = await fixture(t), first = await f.ingest();
  f.time += 2 * 86400000;
  assert.deepEqual(await f.ingest(), first);
  assert.equal((await f.api.binding('owner', 'project-a', f.binding.id)).used, 1);
  f.observation.requestId = word('9');
  await assert.rejects(f.ingest(), { code: 'contract_request_closed' });
  assert.equal(f.submissions, 0);
});

test('finality and exact inbox, requester, capability, input and block binding are required', async t => {
  const f = await fixture(t), original = structuredClone(f.observation);
  for (const patch of [{ finalized: false }, { inbox: address('c') }, { requester: address('c') },
    { capability: word('f') }, { codeHash: word('f') }, { binding: word('f') }, { chainId: 1 },
    { input: { ...original.input, projectId: 'project-b' } }]) {
    f.observation = { ...original, ...patch };
    await assert.rejects(f.ingest());
  }
  f.observation = original; await f.ingest();
  f.observation.blockHash = word('f');
  await assert.rejects(f.ingest(), { code: 'contract_event_changed' });
  assert.equal((await f.api.binding('agent', 'project-a', f.binding.id)).used, 1);
});

test('parallel admission cannot exceed the binding quota or reset it through binding replay', async t => {
  const f = await fixture(t);
  await f.ingest(); f.observation.requestId = word('6');
  await Promise.all([f.ingest(), f.ingest()]);
  f.observation.requestId = word('7');
  await assert.rejects(f.ingest(), { code: 'contract_binding_exhausted' });
  assert.equal((await f.api.bind('agent', 'project-a', f.bindingBody)).used, 2);
  await assert.rejects(f.api.bind('agent', 'project-a', { ...f.bindingBody, maxRequests: 100 }), { code: 'idempotency_conflict' });
  assert.equal(f.submissions, 0);
});

test('an existing proposal with the same ID and different input cannot be reported as this request', async t => {
  const f = await fixture(t), request = await f.ingest(), id = intakeProposalId('project-a', request.id);
  f.proposals.set(id, { id, projectId: 'project-a', requestHash: digest({ different: true }),
    decision: { decision: 'approve', decisionHash: word('9') } });
  await assert.rejects(f.api.run(), { code: 'contract_proposal_mismatch' });
  assert.equal(f.submissions, 0);
});

test('disabled intake does not admit requests and other projects cannot read them', async t => {
  const f = await fixture(t), request = await f.ingest();
  await assert.rejects(f.api.request('owner', 'project-b', request.id), { code: 'scope_denied' });
  f.enabled = false; f.observation.requestId = word('8');
  await assert.rejects(f.ingest(), { code: 'contract_intake_disabled' });
  await f.api.run();
  assert.equal(f.submissions, 0);
});

test('withdrawing a project admission blocks a new binding and queued proposal without consuming another request', async t => {
  const f = await fixture(t), request = await f.ingest();
  f.allowedProjects = [];
  await assert.rejects(f.api.bind('owner', 'project-a', { ...f.bindingBody, idempotencyKey: 'second' }),
    { code: 'contract_intake_disabled' });
  f.observation.requestId = word('8');
  await assert.rejects(f.ingest(), { code: 'contract_intake_disabled' });
  await f.api.run();
  assert.equal(f.submissions, 0);
  assert.equal((await f.api.request('owner', 'project-a', request.id)).state, 'blocked');
  assert.equal((await f.api.binding('owner', 'project-a', f.binding.id)).used, 1);
});

test('a terminal proposal without a decision closes intake without fabricating approval or retrying it', async t => {
  for (const state of ['failed', 'blocked', 'cancelled']) {
    const f = await fixture(t), request = await f.ingest();
    await f.api.run();
    const proposal = f.proposals.get(intakeProposalId('project-a', request.id));
    proposal.state = state; f.advance();
    const result = await f.api.run();
    assert.equal(result.state, 'blocked');
    const saved = await f.api.request('owner', 'project-a', request.id);
    assert.equal(saved.state, 'blocked'); assert.equal(saved.result, null);
    assert.equal(saved.error, 'proposal_' + state);
    f.advance(); assert.equal((await f.api.run()).idle, true);
    assert.equal(f.submissions, 1);
    assert.equal(proposal.state, state);
  }
});

test('an elapsed request deadline stops waiting but preserves the already submitted proposal', async t => {
  const f = await fixture(t), request = await f.ingest();
  await f.api.run();
  f.time = f.observation.deadline * 1000 + 1;
  assert.equal((await f.api.run()).state, 'blocked');
  const saved = await f.api.request('owner', 'project-a', request.id);
  assert.equal(saved.error, 'contract_request_closed'); assert.equal(saved.result, null);
  assert.equal(f.submissions, 1); assert.equal(f.proposals.size, 1);
  f.decide(request); f.advance(); assert.equal((await f.api.run()).idle, true);
});

test('an expired credential stops queued work without repeated authorization retries', async t => {
  const f = await fixture(t), request = await f.ingest();
  f.authExpired = true;
  assert.equal((await f.api.run()).state, 'blocked');
  f.authExpired = false;
  const saved = await f.api.request('owner', 'project-a', request.id);
  assert.equal(saved.error, 'unauthenticated'); assert.equal(saved.result, null);
  f.advance(); assert.equal((await f.api.run()).idle, true);
  assert.equal(f.submissions, 0);
});


test('public intake uses durable credentials and one outstanding request per project', async t => {
  const f = await fixture(t);
  await f.store.transaction(tx => tx.write('public-chain-projects', 'project-a', { projectId: 'project-a' }, 0));
  await assert.rejects(f.api.bind('owner', 'project-a', { ...f.bindingBody, idempotencyKey: 'owner-session' }),
    { code: 'durable_agent_required' });
  await assert.rejects(f.api.bind('agent', 'project-a', { ...f.bindingBody, expiresAt: f.time + 3 * 86400000, idempotencyKey: 'too-long' }),
    { code: 'binding_exceeds_authority' });
  const first = await f.ingest(); f.observation.requestId = word('6');
  await assert.rejects(f.ingest(), { code: 'contract_request_in_progress' });
  assert.equal((await f.api.binding('agent', 'project-a', f.binding.id)).used, 1);
  const prior = (await f.store.read('contract-requests', first.id)).value;
  await f.jobs.cancel('agent', 'project-a', prior.jobId);
  await Promise.all([f.ingest(), f.ingest()]);
  assert.equal((await f.api.binding('agent', 'project-a', f.binding.id)).used, 2);
});

test('a daily decision limit waits on the same request, while lifetime exhaustion is terminal', async t => {
  const f=await fixture(t), request=await f.ingest();
  f.capacityError=Object.assign(new Error('capacity'),{code:'decision_capacity_reached',retryAt:f.time+60000});
  assert.equal((await f.api.run()).state,'waiting');
  assert.equal(f.submissions,0);assert.equal((await f.api.binding('owner','project-a',f.binding.id)).used,1);
  f.advance();f.capacityError=null;
  await f.api.run();assert.equal(f.submissions,1);
  f.decide(request);f.advance();await f.api.run();
  assert.equal((await f.api.request('owner','project-a',request.id)).error,null);
  const exhausted=await fixture(t);await exhausted.ingest();
  exhausted.capacityError=Object.assign(new Error('capacity'),{code:'decision_capacity_reached'});
  assert.equal((await exhausted.api.run()).state,'blocked');assert.equal(exhausted.submissions,0);
});

test('an authorized binding read exposes the latest rejected event without implying admission',async t=>{
 const f=await fixture(t);const rejected={bindingId:f.binding.id,code:'contract_request_in_progress',transactionHash:word('7'),logIndex:2,observedAt:f.time};
 await f.store.transaction(tx=>tx.write('contract-intake-rejections',digest({inbox:f.binding.inbox,bindingId:f.binding.id}),rejected,0));
 assert.deepEqual((await f.api.binding('owner','project-a',f.binding.id)).latestRejection,rejected);
 assert.equal((await f.api.binding('owner','project-a',f.binding.id)).used,0);
});

test('mainnet queue retains the original request through restart and cannot be claimed by Sepolia', async t => {
  const f = await fixture(t, 1), request = await f.ingest();
  assert.equal((await f.api.run(11155111)).idle, true);
  f.loseResponse = true; await f.api.run(1);
  f.open(); f.advance(); f.decide(request); await f.api.run(1);
  assert.equal(f.submissions, 1);
  assert.equal((await f.api.request('owner', 'project-a', request.id)).state, 'result_ready');
  assert.equal((await f.ingest()).id, request.id);
  await f.api.revoke('owner', 'project-a', f.binding.id);
  assert.ok((await f.api.binding('owner', 'project-a', f.binding.id)).revokedAt);
});
