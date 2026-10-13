import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/storage/index.mjs';
import {createJobs} from '../src/jobs/index.mjs';
import {createPulseScheduler} from '../reference/pulse-scheduler.mjs';
import {createPulsePipeline} from '../reference/pulse-pipeline.mjs';
import {digest} from '../src/shared/index.mjs';
import {createPulseProvider,createPulseProviderWorker,pulseDefinitions} from '../reference/pulse-providers.mjs';
import {schemaDefinition,schemaSample,schemaValue} from '../src/services/schema.mjs';

test('three providers satisfy the real manifest schema and reject a mismatched independent source',async()=>{
 const now=()=>1800000000000,block={number:14n,hash:'0x'+'01'.repeat(32),timestamp:1799999700n,baseFeePerGas:20n};
 let other={...block};
 const primary={getChainId:async()=>1,getBlock:async()=>block};
 const secondary={getChainId:async()=>1,getBlock:async()=>other};
 const roles=Object.fromEntries(Object.keys(pulseDefinitions).map(role=>[role,createPulseProvider({role,chainId:1,primary,secondary,now})]));
 for(const [role,d] of Object.entries(pulseDefinitions)){
  schemaDefinition(d.inputSchema);schemaDefinition(d.outputSchema);
  schemaValue(d.outputSchema,await roles[role].execute(schemaSample(d.inputSchema),{purpose:'conformance'}));
 }
 const observation=await roles.observer.execute({chainId:1});schemaValue(pulseDefinitions.observer.outputSchema,observation);
 const result=await roles.evaluator.execute({observation,thresholdWei:'10',ruleVersion:1});
 schemaValue(pulseDefinitions.evaluator.outputSchema,result);
 assert.deepEqual(await roles.consumer.execute({evaluation:result}),result);
 other={...block,hash:'0x'+'02'.repeat(32)};
 await assert.rejects(roles.consumer.execute({evaluation:result}),{code:'pulse_source_mismatch'});
});

test('reference scheduler preserves the original pending run across expiry and restarts',async t=>{
 const store=openStore(':memory:');t.after(()=>store.close());
 let time=1800000000000,complete=false,calls=[];
 const jobs=createJobs({store,identity:{authorize:async()=>{}},now:()=>time});
 const config={projectId:'consumer',startsAt:time,expiresAt:time+7200000,intervalMs:3600000,maximumRuns:2};
 const pipeline={async step(run,checkpoint){
  calls.push(run.id);run.write??={operation:{id:'original'}};
  await checkpoint(run);
  return {...run,state:complete?'complete':'waiting'};
 }};
 const make=()=>createPulseScheduler({store,jobs,pipeline,config,now:()=>time});
 assert.equal((await make().tick()).state,'waiting');
 time+=3600001;assert.equal((await make().tick()).state,'waiting');
 time+=3600001;complete=true;assert.equal((await make().tick()).state,'complete');
 assert.equal(new Set(calls).size,1);
 assert.equal((await make().tick()).state,'expired');
 assert.equal((await store.list('workflow-jobs')).length,1);
});

test('data pipeline recovers a lost prepare response and never replaces its original orders or write',async()=>{
 let time=1800000000000,saved,prepareLost=true,confirmed=false,pubCalls=0;
 const orders=new Map(),publications=new Map(),prepared=new Map(),submitted=[];
 const observation={status:'ok',observedAt:Math.floor(time/1000),onchainData:'0x01'};
 const evaluation={status:'ok',observation,thresholdWei:'10',ruleVersion:1,onchainData:'0x01'};
 const call=async(name,a)=>{
  if(name==='service_quote')return {id:a.idempotencyKey,maximumWei:'0',request:a};
  if(name==='service_accept'){if(!orders.has(a.quoteId))orders.set(a.quoteId,{id:a.quoteId,state:'delivered',
   outputHash:digest(a.quoteId.endsWith('observer')?observation:evaluation)});return orders.get(a.quoteId);}
  if(name==='service_order')return orders.get(a.orderId);
  if(name==='service_result')return a.orderId.endsWith('observer')?observation:evaluation;
  if(name==='service_accept_result')return {accepted:true};
  if(name==='service_result_publication')return publications.get(a.orderId)??{revision:0};
  if(name==='service_result_publish'){pubCalls++;const value={...a,revision:1};publications.set(a.orderId,value);return value;}
  if(name==='public_service_result')return publications.get(a.orderId);
  if(name==='signal_latest')return {finalized:true,record:{sequence:'0'}};
  if(name==='signal_grant')return {finalized:true,revoked:false,terms:{expiresAt:1800005400}};
  if(name==='signal_record_prepare'){
   const prior=prepared.get(a.idempotencyKey);
   if(prior)assert.equal(digest(prior.input),digest(a));
   else prepared.set(a.idempotencyKey,{id:'fixed-write',input:a});
   if(prepareLost){prepareLost=false;throw Error('lost_response');}
   return prepared.get(a.idempotencyKey);
  }
  if(name==='signal_submit'){submitted.push(a.transactionHash);return {state:'pending'};}
  if(name==='signal_operation')return {state:confirmed?'confirmed':'pending',transactionHash:'0xoriginal'};
  throw Error(name);
 };
 const make=()=>createPulsePipeline({client:{call},projectId:'consumer',observerServiceId:'a',evaluatorServiceId:'b',
  consumerProvider:{execute:async()=>evaluation},publisher:{step:async()=>({state:confirmed?'confirmed':'pending',transactionHash:'0xoriginal'})},
  grantId:'grant',signal:{chainId:1},readRule:async()=>({thresholdWei:'10',version:1,maximumAge:7200}),now:()=>time});
 const checkpoint=async x=>{saved=structuredClone(x);};
 await assert.rejects(make().step({id:'run-1',expiresAt:time+3600000,serviceExpiresAt:time+7200000},checkpoint),/lost_response/);
 await make().step(saved,checkpoint);assert.equal(prepared.size,1);assert.equal(orders.size,2);assert.equal(pubCalls,2);
 assert.equal(prepared.get('run-1').input.validUntil,Math.floor(time/1000)+5400);
 assert([...publications.values()].every(p=>p.expiresAt===time+5400000));
 time+=8000000;confirmed=true;
 assert.equal((await make().step(saved,checkpoint)).state,'complete');
 assert.deepEqual(submitted,['0xoriginal']);
});

test('an unsigned failed intent releases the next scheduler slot but an unknown signed transaction retains it',async t=>{
 const store=openStore(':memory:');t.after(()=>store.close());let time=1800000000000,signed=false;
 const jobs=createJobs({store,identity:{authorize:async()=>{}},now:()=>time});
 const config={projectId:'lane',startsAt:time,expiresAt:time+14400000,intervalMs:3600000,maximumRuns:4};
 const pipeline={async step(run,checkpoint){run.write={operation:{id:'op-'+run.id}};await checkpoint(run);
   if(signed&&!await store.read('chain-transactions','signal-record:'+run.write.operation.id))await store.transaction(tx=>tx.write('chain-transactions','signal-record:'+run.write.operation.id,{state:'unknown'},0));
   throw Object.assign(Error('denied'),{code:'signal_budget_exhausted'});
 }};
 const tick=()=>createPulseScheduler({store,jobs,pipeline,config,now:()=>time}).tick();
 assert.equal((await tick()).state,'failed');time+=3600001;signed=true;
 const first=await tick();assert.equal(first.state,'unavailable');time+=7200001;
 const next=await tick();assert.equal(next.runId,first.runId);assert.equal(next.state,'unavailable');
 assert.equal((await store.list('workflow-jobs')).length,2);
 for(const row of await store.list('chain-transactions'))await store.transaction(tx=>tx.write('chain-transactions',row.id,{state:'cancelled'},row.revision));
 time+=60001;assert.equal((await tick()).state,'failed');signed=false;
 assert.equal((await tick()).state,'failed');
 assert.equal((await store.list('workflow-jobs')).length,3);
});
test('a poisoned public order cannot abort unrelated provider deliveries',async()=>{
 const delivered=[];const client={async call(name,a){
  if(name==='provider_orders')return {orders:[{id:'bad',serviceId:'s'},{id:'good',serviceId:'s'}]};
  if(name==='provider_claim')return {state:'working',input:{id:a.orderId},lease:'lease'};
  if(name==='provider_deliver'){delivered.push(a.orderId);return {};}
  throw Error(name);
 }};
 const result=await createPulseProviderWorker({client,projectId:'provider',serviceId:'s',provider:{async execute(input){
  if(input.id==='bad')throw Object.assign(Error('source'),{code:'pulse_source_mismatch'});return {status:'ok'};
 }}}).tick();
 assert.deepEqual(delivered,['good']);assert.equal(result.failed,1);assert.equal(result.delivered,1);
});

test('a finalized hosted receipt retains its API handoff across outage and run expiry',async t=>{
 const store=openStore(':memory:');t.after(()=>store.close());let time=1800000000000;
 const jobs=createJobs({store,identity:{authorize:async()=>{}},now:()=>time});
 const config={projectId:'handoff',startsAt:time,expiresAt:time+14400000,intervalMs:3600000,maximumRuns:4};
 const pipeline={async step(run,checkpoint){run.write={operation:{id:'op-'+run.id}};await checkpoint(run);
  const id=run.write.operation.id;
  if(!await store.read('chain-transactions','signal-record:'+id))await store.transaction(async tx=>{
   await tx.write('chain-transactions','signal-record:'+id,{state:'confirmed',hash:'0xoriginal'},0);
   await tx.write('signal-operations',id,{state:'prepared'},0);
  });
  throw Error('API unavailable');
 }};
 const tick=()=>createPulseScheduler({store,jobs,pipeline,config,now:()=>time}).tick();
 const first=await tick();assert.equal(first.state,'unavailable');time+=7200001;
 const retained=await tick();assert.equal(retained.state,'unavailable');assert.equal(retained.runId,first.runId);
 const api=await store.read('signal-operations','op-'+first.runId);
 await store.transaction(tx=>tx.write('signal-operations','op-'+first.runId,{state:'confirmed',transactionHash:'0xoriginal'},api.revision));
 time+=60001;assert.equal((await tick()).state,'failed');
});
