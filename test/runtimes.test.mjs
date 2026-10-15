import test from 'node:test';import assert from 'node:assert/strict';
import {openStore} from '../src/storage/index.mjs';import {createRuntimes} from '../src/runtimes/index.mjs';import {createIdentity} from '../src/identity/index.mjs';import {ROUTES} from '../interfaces/contract.mjs';
async function fixture(t){
 const store=openStore(':memory:');t.after(()=>store.close());let time=1800000000000;
 const identity=createIdentity({store,domain:'claus.si',now:()=>time,verifySignature:()=>true});
 await store.transaction(async tx=>{await tx.write('projects','p',{id:'p',ownerId:'owner',archivedAt:null},0);await tx.write('credentials','owner-credential',{id:'owner-credential',kind:'owner',principalId:'owner',expiresAt:time+3600000,revokedAt:null},0);});
 const runs=new Map(),executions=[];let output={state:{round:1},action:{operation:'inference_get',input:{projectId:'foreign',requestId:'request'}}};
 const workers={get:async()=>({revision:1,enabled:true}),discovery:async()=>({enabled:true}),run:async(actor,projectId,i)=>{await identity.authorize(actor,'worker.run',{projectId});if(!runs.has(i.idempotencyKey))runs.set(i.idempotencyKey,{id:i.idempotencyKey,state:'completed',result:output});return runs.get(i.idempotencyKey);},runGet:async(_,p,id)=>runs.get(id)};
 const make=()=>createRuntimes({store,identity,workers,now:()=>time,route:n=>ROUTES.find(r=>r.name===n),execute:async(n,i,a)=>{await identity.authorize(a,'inference.read',{projectId:i.projectId});executions.push({n,i});return {state:'complete'};}});
 let api=make();const config={runtimeId:'research',workerId:'brain',workerRevision:1,intervalSeconds:60,maxCycles:50,initialState:{},enabled:true,expectedRevision:0};await api.configure('owner-credential','p',config);
 return {store,identity,config,runs,executions,get api(){return api;},advance:()=>{time+=61000;},restart:()=>{api=make();},setOutput:v=>{output=v;}};
}
test('runtime resumes worker and action from saved state and binds inference to its own project',async t=>{
 const f=await fixture(t);await f.api.tick();f.restart();f.advance();await f.api.tick();f.restart();await f.api.tick();
 assert.equal(f.runs.size,1);assert.equal(f.executions.length,1);assert.equal(f.executions[0].i.projectId,'p');
 const state=await f.api.get('owner-credential','p','research');assert.equal(state.cycle,1);assert.deepEqual(state.memory,{round:1});assert.equal('actor' in state,false);
});
test('runtime stopping revokes its machine authority and retains pending work',async t=>{
 const f=await fixture(t);await f.api.tick();const before=await f.api.get('owner-credential','p','research');const row=await f.store.read('project-runtimes','p:research');
 await f.api.stop('owner-credential','p','research',{expectedRevision:before.revision});
 await assert.rejects(f.identity.authorize(row.value.actor,'worker.run',{projectId:'p'}),{code:'scope_denied'});
 f.advance();await f.api.tick();assert.deepEqual((await f.api.get('owner-credential','p','research')).pending,before.pending);assert.equal(f.executions.length,0);
});
test('worker output cannot grant money or access admin operations',async t=>{
 const f=await fixture(t);f.setOutput({state:{},action:{operation:'compute_grant_set',input:{}}});await f.api.tick();f.advance();await f.api.tick();
 const result=await f.api.get('owner-credential','p','research');assert.equal(result.state,'blocked');assert.equal(result.observation.error,'runtime_action_denied');assert.equal(f.executions.length,0);
});
