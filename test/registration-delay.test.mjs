import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256 } from 'viem';
import { createChainRead } from '../adapters/chain-read.mjs';
import { createHttp } from '../interfaces/http.mjs';
import { ROUTES } from '../interfaces/contract.mjs';

function registration(minimum) {
  const code = '0x60006000', codeHash = keccak256(code);
  const executor = '0x' + '11'.repeat(20);
  const chain = createChainRead({ client: {
    getChainId: async () => 11155111, getBlockNumber:async()=>100n,
    getCode: async () => code,
    readContract: async ({ address, functionName }) => {
      assert.equal(address, executor);
      assert.equal(functionName, 'MIN_UPGRADE_DELAY');
      return minimum;
    },
  } });
  const input = {
    projectId: 'prj_zero_delay', owner: '0x' + '22'.repeat(20),
    module: { id: 'module', state: 'verified', chainId: 11155111, address: '0x' + '33'.repeat(20), codeHash },
    configuration: '0x', mandateHash: '0x' + '44'.repeat(32),
    capability: { enabled: true, chainId: 11155111, profile: 'claus-readonly-v1', executor, executorCodeHash: codeHash },
    expiresAt: 1800000000,
  };
  return delay => chain.registration({ ...input, minDelaySeconds: delay });
}

test('new executor prepares a signed zero-delay registration without adding a waiting period', async () => {
  const prepared = await registration(0n)(0);
  assert.equal(prepared.message.minDelaySeconds, 0);
  assert.equal(prepared.primaryType, 'Registration');
});

test('legacy executor refuses an impossible zero-delay registration before requesting an owner signature', async () => {
  const prepare = registration(3600n);
  await assert.rejects(prepare(0), { code: 'executor_delay_required' });
  await assert.rejects(prepare(3599), { code: 'executor_delay_required' });
  assert.equal((await prepare(3600)).message.minDelaySeconds, 3600);
});

test('optional project delays stay explicit and invalid delays are rejected', async () => {
  const prepare = registration(0n);
  assert.equal((await prepare(60)).message.minDelaySeconds, 60);
  for (const delay of [-1, 0.5, undefined, NaN, 432001]) {
    await assert.rejects(prepare(delay), { code: 'invalid_registration' });
  }
});

test('legacy delay conflicts reach the client as non-retryable, not a provider outage', async () => {
  const handle = createHttp({ service: {
    routes: ROUTES.filter(route => route.name === 'registration_prepare'),
    execute: async (_name, input) => registration(3600n)(input.minDelaySeconds),
  } });
  const response = await handle(new Request('https://claus.si/v1/projects/test/chain/registrations/prepare', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ minDelaySeconds: 0 }),
  }));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'executor_delay_required', category: 'state', retryable: false });
});

import { openStore } from '../src/storage/index.mjs';
import { createChainDeployments } from '../src/chain-deployments/index.mjs';
import { digest } from '../src/shared/index.mjs';

test('concurrent registration preparation reuses one bounded intent and legacy alternatives cannot flood dispatch', async t => {
  const store=openStore(':memory:'); t.after(()=>store.close()); let clock=1800000000000, enqueued=0;
  const projectId='registration-bound', moduleId='module', mandateId='mandate';
  await store.transaction(async tx=>{
    await tx.write('network-capabilities','chain',{enabled:true,chainId:11155111},0);
    await tx.write('review-pilots',projectId,{enabled:true,expiresAt:clock+86400000},0);
    await tx.write('chain-modules',moduleId,{projectId,state:'verified',chainId:11155111},0);
    await tx.write('principals','owner',{address:'0x'+'11'.repeat(20)},0);
    await tx.write('mandates',mandateId,{projectId,expiresAt:clock+86400000,scopes:['proposal.execute']},0);
  });
  const deployments=createChainDeployments({store,now:()=>clock,
    identity:{authorize:async()=>{},credential:async()=>({kind:'owner',principalId:'owner'}),project:async()=>({ownerId:'owner'})},
    chain:{registration:async input=>({chainId:11155111,configuration:input.configuration,message:{expiresAt:input.expiresAt,minDelaySeconds:input.minDelaySeconds}}),verifyRegistration:async()=>true},
    jobs:{enqueue:async()=>({id:'job-'+(++enqueued)})}});
  const input={moduleId,mandateId,configuration:'0x01',minDelaySeconds:0};
  const calls=await Promise.all(Array.from({length:8},()=>deployments.prepareRegistration('owner',projectId,input)));
  assert.equal(new Set(calls.map(x=>x.id)).size,1);clock+=1000;
  assert.equal((await deployments.prepareRegistration('owner',projectId,input)).id,calls[0].id);
  await assert.rejects(deployments.prepareRegistration('owner',projectId,{...input,configuration:'0x02'}),{code:'registration_in_progress'});
  const legacy={...calls[0],id:digest('legacy'),configuration:'0x03'};
  await store.transaction(tx=>tx.write('chain-registrations',legacy.id,legacy,0));
  await deployments.submitRegistration('owner',projectId,{registrationId:calls[0].id,signature:'fixture'});
  await assert.rejects(deployments.submitRegistration('owner',projectId,{registrationId:legacy.id,signature:'fixture'}),{code:'registration_in_progress'});
  assert.equal(enqueued,1);
  await store.transaction(tx=>tx.write('chain-bindings',projectId,{chainId:11155111},0));
  await assert.rejects(deployments.submitRegistration('owner',projectId,{registrationId:legacy.id,signature:'fixture'}),{code:'project_already_registered'});
  assert.equal(enqueued,1);
});
