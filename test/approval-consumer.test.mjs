import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/storage/index.mjs';
import { createApprovals } from '../src/approvals/index.mjs';

test('a vault added after proposal creation blocks both a paid decision and protected execution', async t => {
  for (const method of ['runDecision', 'runExecution']) {
    const store = openStore(':memory:'); t.after(() => store.close());
    const projectId = 'prj_fixture', id = 'proposal', address = '0x' + '12'.repeat(20);
    const value = { id, projectId, proposal: { target: address }, inputArtifactHash: 'fixture', state: 'reviewing' };
    await store.transaction(async tx => {
      await tx.write('chain-proposals', id, value, 0);
      await tx.write('project-vaults', projectId, { state: 'verified', address, codeHash: 'new-vault' }, 0);
    });
    const claim = { mode: 'dispatch', job: { projectId, payload: { proposalId: id }, authority: { actor: {} } } };
    const jobs = { claim: async () => claim, assertCurrent: async () => {},
      beginEffect: async (_claim, authorize) => store.transaction(tx => authorize(null, tx)),
      finish: async (_claim, result, change) => store.transaction(async tx => { await change(tx); return result; }) };
    const approvals = createApprovals({ store, jobs, identity: { authorize: async () => {} },
      deployments: { allowed: async () => {} }, artifacts: { get: async () => ({ evidence: { chain: {} } }) } });
    let calls = 0;
    const result = await approvals[method]({ step: async () => { calls++; throw Error('must not dispatch'); } });
    assert.equal(result.state, 'blocked');
    assert.equal(calls, 0);
    assert.equal((await store.read('chain-proposals', id)).value.error, 'vault_review_context_changed');
  }
});

test('a signal store added after the signed input blocks an old readonly-only decision and execution', async t => {
  for (const method of ['runDecision','runExecution']) {
    const store=openStore(':memory:');t.after(()=>store.close());
    const projectId='prj_signal',id='old-proposal',address='0x'+'11'.repeat(20);
    await store.transaction(async tx=>{
      await tx.write('chain-proposals',id,{id,projectId,proposal:{target:address},inputArtifactHash:'old',state:'reviewing'},0);
      await tx.write('project-signals',projectId,{state:'verified',address,codeHash:'store'},0);
    });
    const claim={mode:'dispatch',job:{projectId,payload:{proposalId:id},authority:{actor:{}}}};
    const jobs={claim:async()=>claim,assertCurrent:async()=>{},beginEffect:async(_,authorize)=>store.transaction(tx=>authorize(null,tx)),
      finish:async(_,result,change)=>store.transaction(async tx=>{await change(tx);return result;})};
    const api=createApprovals({store,jobs,identity:{authorize:async()=>{}},deployments:{allowed:async()=>{}},
      artifacts:{get:async()=>({evidence:{chain:{}}})}});
    let calls=0;const result=await api[method]({step:async()=>{calls++;throw Error('unexpected effect');}});
    assert.equal(result.state,'blocked');assert.equal(calls,0);
    assert.equal((await store.read('chain-proposals',id)).value.error,'signal_review_context_changed');
  }
});
