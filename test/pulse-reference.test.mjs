import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/storage/index.mjs';
import {createJobs} from '../src/jobs/index.mjs';
import {createPulseScheduler} from '../reference/pulse-scheduler.mjs';
import {createPulsePipeline} from '../reference/pulse-pipeline.mjs';
import {digest} from '../src/shared/index.mjs';
import {createPulseProvider,pulseDefinitions} from '../reference/pulse-providers.mjs';
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
 await assert.rejects(make().step({id:'run-1',expiresAt:time+7200000,serviceExpiresAt:time+7200000},checkpoint),/lost_response/);
 await make().step(saved,checkpoint);assert.equal(prepared.size,1);assert.equal(orders.size,2);assert.equal(pubCalls,2);
 time+=8000000;confirmed=true;
 assert.equal((await make().step(saved,checkpoint)).state,'complete');
 assert.deepEqual(submitted,['0xoriginal']);
});
