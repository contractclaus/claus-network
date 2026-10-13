import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/storage/index.mjs';
import { createSignals } from '../src/signals/index.mjs';
import { digest, requireThat } from '../src/shared/index.mjs';
const address = c => '0x'+c.repeat(40), word = c => '0x'+c.repeat(64);
async function fixture(t) {
  const store=openStore(':memory:');t.after(()=>store.close());
  const f={now:1800000000000,final:false,source:true,chainDown:false,calls:0};
  const binding={chainId:1,profile:'claus-readonly-v1',owner:address('1'),executor:address('2'),target:address('3'),projectKey:word('a')};
  const config={enabled:true,profile:'claus-signal-v1',chainId:1,factory:address('4'),factoryCodeHash:word('b'),executor:binding.executor,
    artifactProjectId:'review-project',factoryArtifactHash:digest('factory'),storeArtifactHash:digest('store'),reviewCaseId:'review',
    reviewArtifactHash:digest('report'),feedId:word('c'),schemaHash:word('d'),expiresAt:f.now+86400000};
  const signal={chainId:1,address:address('5'),codeHash:word('e'),factory:config.factory,factoryCodeHash:config.factoryCodeHash,
    evaluator:binding.target,executor:binding.executor,projectKey:binding.projectKey,feedId:config.feedId,schemaHash:config.schemaHash};
  const transaction={chainId:1,from:binding.owner,to:config.factory,data:'0x1234',value:'0'};
  const identity={credential:async actor=>({kind:actor==='owner'?'owner':'agent'}),authorize:async(actor,scope,{projectId})=>{
    requireThat(projectId==='p' && (actor==='owner' || actor==='publisher' && ['signal.read','signal.publish','signal.grant.revoke'].includes(scope) ||
      actor==='reader' && scope==='signal.read'),'scope_denied');}};
  const chain={
    prepareStore:async()=>{f.calls++;return {transaction};},
    prepareGrant:async()=>({grantId:word('1'),typedData:{message:{publisher:address('6')}},owner:binding.owner}),
    registerGrant:async()=>({transaction}),
    prepareRecord:async()=>{requireThat(!f.chainDown,'signal_chain_unavailable');return {transaction};},
    prepareRevoke:async()=>{requireThat(!f.chainDown,'signal_chain_unavailable');return {transaction};},
    observe:async(a,h)=> f.final ? {state:'confirmed',...(a.kind==='store'?{signal}:{}),transactionHash:h,blockHash:word('f'),blockNumber:'50',finalized:true} : {state:'pending'},
    grant:async()=>({id:word('1'),terms:{publisher:address('6')},revoked:false}),
    latest:async()=>{requireThat(!f.chainDown,'signal_chain_unavailable');return {record:{sequence:'1',validUntil:String(Math.floor(f.now/1000)+60)},finalized:true};}
  };
  const sourceResult={id:'order',revision:1,outputHash:digest('output')};
  const make=()=>createSignals({store,identity,chain,artifacts:{get:async()=>({})},now:()=>f.now,
    publicResult:async()=>{requireThat(f.source,'public_result_unavailable');return {...sourceResult,output:{onchainData:'0x1234'}};}});
  await store.transaction(async tx=>{
    await tx.write('chain-bindings','p',binding,0);
    await tx.write('network-capabilities','signal:1',config,0);
    await tx.write('review-cases','review',{state:'reviewed',projectId:config.artifactProjectId,artifactHash:config.reviewArtifactHash},0);
    await tx.write('signal-admission-assessments',digest(config),{accepted:true,profileHash:digest(config),reviewArtifactHash:config.reviewArtifactHash,
      factoryArtifactHash:config.factoryArtifactHash,storeArtifactHash:config.storeArtifactHash},0);
    await tx.write('projects','p',{slug:'pulse',ownerId:'owner'},0);
    await tx.write('public-projects','pulse',{projectId:'p',published:true},0);
  });
  Object.assign(f,{store,make,api:make(),sourceResult,config});
  f.setup=async()=>{const op=await f.api.storePrepare('owner','p',{idempotencyKey:'store'});f.final=true;
    await f.api.submit('owner','p',{operationId:op.id,transactionHash:word('1')});return op;};
  f.record=()=>({grantId:word('1'),sequence:1,expectedVersion:1,observedAt:Math.floor(f.now/1000),validUntil:Math.floor(f.now/1000)+60,
    sourceResult,data:'0x1234',idempotencyKey:'first-record'});
  return f;
}

test('signal deployment keeps the exact action and unknown transaction through restart; read scope cannot inject a receipt',async t=>{
  const f=await fixture(t),input={idempotencyKey:'store'};
  const a=await f.api.storePrepare('owner','p',input);
  assert.deepEqual(await f.api.storePrepare('owner','p',input),a);assert.equal(f.calls,1);
  await assert.rejects(f.api.submit('reader','p',{operationId:a.id,transactionHash:word('1')}),{code:'scope_denied'});
  assert.equal((await f.api.submit('owner','p',{operationId:a.id,transactionHash:word('1')})).state,'pending');
  f.api=f.make();f.final=true;
  assert.equal((await f.api.operation('owner','p',a.id)).state,'confirmed');
  assert.equal((await f.api.get('owner','p')).address,address('5'));
  await assert.rejects(f.api.submit('owner','p',{operationId:a.id,transactionHash:word('2')}),{code:'signal_transaction_conflict'});
  assert.equal((await f.store.list('signal-operations')).length,1);
});

test('API revocation survives RPC failure and stops new records; onchain state stays explicit',async t=>{
  const f=await fixture(t);await f.setup();
  const record=await f.api.recordPrepare('publisher','p',f.record());assert.equal(record.state,'prepared');
  f.chainDown=true;
  const input={grantId:word('1'),idempotencyKey:'revoke'};
  await assert.rejects(f.api.revoke('publisher','p',input),{code:'signal_chain_unavailable'});
  assert.equal((await f.api.grant('reader','p',word('1'))).onchainRevocation,'not_submitted');
  await assert.rejects(f.api.recordPrepare('publisher','p',{...f.record(),idempotencyKey:'second'}),{code:'signal_api_revoked'});
  f.chainDown=false;const revoke=await f.api.revoke('publisher','p',input);
  await f.api.submit('publisher','p',{operationId:revoke.id,transactionHash:word('3')});
  assert.equal((await f.api.grant('reader','p',word('1'))).onchainRevocation,'confirmed');
  assert.equal((await f.api.operation('publisher','p',record.id)).id,record.id);
});

test('a public source binds exact bytes and revision; withdrawn source cannot create a new write',async t=>{
  const f=await fixture(t);await f.setup();
  await assert.rejects(f.api.recordPrepare('publisher','p',{...f.record(),data:'0x5678'}),{code:'signal_source_changed'});
  await assert.rejects(f.api.recordPrepare('publisher','p',{...f.record(),sourceResult:{...f.sourceResult,revision:2}}),{code:'signal_source_changed'});
  f.source=false;await assert.rejects(f.api.recordPrepare('publisher','p',f.record()),{code:'public_result_unavailable'});
  assert.equal((await f.store.list('signal-operations')).length,1);
});

test('expired profile closes new actions while reading and owner revocation remain available',async t=>{
  const f=await fixture(t);await f.setup();f.now+=86400001;
  assert.equal((await f.api.discovery(1)).admission,'not_enabled');
  await assert.rejects(f.api.recordPrepare('publisher','p',f.record()),{code:'signal_not_enabled'});
  assert.equal((await f.api.latest('reader','p')).state,'current');
  assert.equal((await f.api.revoke('owner','p',{grantId:word('1'),idempotencyKey:'expired-revoke'})).state,'prepared');
});

test('public feed requires separate publication; unavailable data is not called current',async t=>{
  const f=await fixture(t);await f.setup();
  await assert.rejects(f.api.public('p'),{code:'not_found'});
  await f.api.publish('owner','p',{published:true,expectedRevision:0});
  assert.equal((await f.api.public('p')).state,'current');
  f.chainDown=true;assert.equal((await f.api.public('p')).state,'unavailable');
  await f.api.publish('owner','p',{published:false,expectedRevision:1});
  await assert.rejects(f.api.public('p'),{code:'not_found'});
});
