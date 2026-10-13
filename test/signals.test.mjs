import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/storage/index.mjs';
import { createSignals } from '../src/signals/index.mjs';
import { digest, requireThat } from '../src/shared/index.mjs';
const address = c => '0x'+c.repeat(40), word = c => '0x'+c.repeat(64);
async function fixture(t) {
  const store=openStore(':memory:');t.after(()=>store.close());
  const f={now:1800000000000,final:false,source:true,chainDown:false,calls:0,authorizationActive:true,currentVersion:1};
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
    validateAdmission:async()=>{if(f.admissionDown)throw f.admissionDown instanceof Error?f.admissionDown:Error('https://rpc.invalid/private-token');},validateStoreBuild:async()=>{},
    prepareStore:async()=>{f.calls++;return f.recover?{recovered:true,signal,blockHash:word('f'),blockNumber:'50',finalized:true}:{transaction};},
    assertTrackedStore:async(_c,_b,tracked)=>requireThat(!f.untracked||tracked,'signal_review_context_changed'),
    prepareGrant:async()=>({grantId:word('1'),typedData:{message:{publisher:address('6')}},owner:binding.owner}),
    registerGrant:async()=>({transaction}),
    prepareRecord:async()=>{requireThat(!f.chainDown,'signal_chain_unavailable');return {transaction};},
    prepareRevoke:async()=>{requireThat(!f.chainDown,'signal_chain_unavailable');return {transaction};},
    observe:async(a,h)=>{requireThat(h!==word('9'),'signal_transaction_mismatch');return f.final ? {state:'confirmed',...(a.kind==='store'?{signal}:{}),transactionHash:h,blockHash:word('f'),blockNumber:'50',finalized:true} : {state:'pending'};},
    grant:async()=>({id:word('1'),terms:{publisher:address('6')},revoked:false}),
    latest:async()=>{requireThat(!f.chainDown,'signal_chain_unavailable');return {record:{sequence:'1',version:'1',validUntil:String(Math.floor(f.now/1000)+60)},authorizationActive:f.authorizationActive,currentVersion:f.currentVersion,finalized:true};}
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

// Finalized history survives revocation and upgrades, but cannot look current.
test('public and authenticated feeds distinguish withdrawn and superseded records',async t=>{
 const f=await fixture(t);await f.setup();await f.api.publish('owner','p',{published:true,expectedRevision:0});
 for(const [active,version,expected] of [[true,1,'current'],[false,1,'withdrawn'],[true,2,'superseded']]){
  f.authorizationActive=active;f.currentVersion=version;
  const authenticated=await f.api.latest('reader','p'),pub=await f.api.public('p');
  assert.equal(authenticated.state,expected);assert.equal(pub.state,expected);
  assert.equal(pub.record.sequence,'1');assert.equal(pub.record.version,'1');
 }
});

test('finalized factory recovery restores the binding without replacing an unknown original hash',async t=>{
 const f=await fixture(t),original=await f.api.storePrepare('owner','p',{idempotencyKey:'original'});
 await f.api.submit('owner','p',{operationId:original.id,transactionHash:word('1')});
 f.recover=true;
 const restored=await f.api.storePrepare('owner','p',{idempotencyKey:'recover'});
 assert.equal(restored.state,'confirmed');assert.equal(restored.recovered,true);assert.equal(restored.transactionHash,undefined);
 assert.equal((await f.api.get('owner','p')).address,address('5'));
 const old=await f.api.operation('owner','p',original.id);
 assert.equal(old.transactionHash,word('1'));assert.equal(old.state,'pending');
});
test('a definitively wrong receipt is rejected before attachment and does not poison a prepared operation',async t=>{
 const f=await fixture(t),op=await f.api.storePrepare('owner','p',{idempotencyKey:'store'});
 await assert.rejects(f.api.submit('owner','p',{operationId:op.id,transactionHash:word('9')}),{code:'signal_transaction_mismatch'});
 assert.equal((await f.api.operation('owner','p',op.id)).transactionHash,undefined);
 f.final=true;assert.equal((await f.api.submit('owner','p',{operationId:op.id,transactionHash:word('1')})).state,'confirmed');
});
test('untracked canonical stores and incompatible consumers fail closed before approval',async t=>{
 const f=await fixture(t);f.untracked=true;
 await assert.rejects(f.api.consumer('p'),{code:'signal_review_context_changed'});
 await f.store.transaction(tx=>tx.write('project-vaults','p',{state:'verified'},0));
 await assert.rejects(f.api.storePrepare('owner','p',{idempotencyKey:'store'}),{code:'signal_review_context_changed'});
 assert.equal((await f.store.list('signal-operations')).length,0);
});

test('an RPC outage marks only signal discovery unavailable and still denies writes',async t=>{
 const f=await fixture(t);await f.setup();f.admissionDown=true;
 assert.deepEqual(await f.api.discovery(1),{chainId:1,profile:'claus-signal-v1',admission:'unavailable',reason:'signal_dependency_unavailable'});
 await assert.rejects(f.api.recordPrepare('publisher','p',f.record()),/rpc.invalid/);
 assert.equal((await f.store.list('signal-operations')).length,1);
 f.admissionDown=Object.assign(Error('private transport context'),{code:'signal_factory_changed'});
 assert.deepEqual(await f.api.discovery(1),{chainId:1,profile:'claus-signal-v1',admission:'not_enabled',reason:'signal_factory_changed'});
});
test('only exact host replacement evidence settles an original pending record',async t=>{
 const f=await fixture(t);await f.setup();f.final=false;
 const op=await f.api.recordPrepare('publisher','p',f.record());
 await f.api.submit('publisher','p',{operationId:op.id,transactionHash:word('2')});
 const key='signal-record:'+op.id, replacement={transactionHash:word('3'),blockHash:word('f'),finalized:true};
 const host={state:'cancelled',hash:word('2'),sender:op.transaction.from,intent:{...op.transaction},replacement};
 await f.store.transaction(tx=>tx.write('chain-transactions',key,{...host,hash:word('4')},0));
 assert.equal((await f.api.operation('publisher','p',op.id)).state,'pending');
 const row=await f.store.read('chain-transactions',key);
 await f.store.transaction(tx=>tx.write('chain-transactions',key,host,row.revision));
 const settled=await f.api.operation('publisher','p',op.id);
 assert.equal(settled.state,'failed');assert.equal(settled.error,'signal_transaction_replaced');
 assert.equal(settled.transactionHash,word('2'));assert.deepEqual(settled.replacement,replacement);
});
test('API revocation prevents preparing registration of an already signed grant',async t=>{
 const f=await fixture(t);await f.setup();
 const grant=await f.api.grantPrepare('owner','p',{publisher:address('6'),maximumWrites:2,minimumInterval:1,
  expiresAt:f.now/1000+3600,nonce:'1',idempotencyKey:'grant'});
 await f.api.revoke('owner','p',{grantId:grant.grantId,idempotencyKey:'revoke-first'});
 await assert.rejects(f.api.grantRegister('owner','p',{operationId:grant.id,signature:'0x'+'11'.repeat(65)}),{code:'signal_api_revoked'});
 assert.equal((await f.api.operation('owner','p',grant.id)).state,'awaiting_signature');
});
