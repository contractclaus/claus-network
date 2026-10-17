import test from 'node:test';import assert from 'node:assert/strict';
import {openStore} from '../src/storage/index.mjs';import {createIdentity} from '../src/identity/index.mjs';import {createRuntimes} from '../src/runtimes/index.mjs';import {ROUTES} from '../interfaces/contract.mjs';
async function fixture(output={state:{done:true},done:true}){
 let time=1000000,nextError=null;const store=openStore(':memory:');
 await store.transaction(async tx=>{await tx.write('projects','prj_one',{id:'prj_one',ownerId:'owner'},0);await tx.write('credentials','owner-token',{id:'owner-token',principalId:'owner',kind:'owner',scopes:[],expiresAt:999999999},0);});
 const now=()=>time,identity=createIdentity({store,now,domain:'example.test',verifySignature:async()=>true}),effects=[];
 const runtime=createRuntimes({store,identity,now,route:n=>ROUTES.find(r=>r.name===n),workers:{get:async()=>({revision:1,enabled:true}),discovery:async()=>({enabled:true,limits:{}}),run:async()=>({id:'original-run'}),runGet:async()=>({state:'completed',result:output})},execute:async(operation,input)=>{effects.push({operation,input});if(nextError){const error=nextError;nextError=null;throw Object.assign(new Error(error),{code:error});}return{id:'original-file',bytes:2};}});
 const input={runtimeId:'helper',workerId:'worker',workerRevision:1,intervalSeconds:60,maxCycles:20,initialState:{},enabled:true,dataAccess:'read_write',expectedRevision:0};
 return {store,runtime,identity,input,effects,advance:ms=>{time+=ms;},failNext:code=>{nextError=code;}};
}
test('configuring a runtime as disabled revokes its internal access without creating another grant',async()=>{const f=await fixture();try{
 const r=await f.runtime.configure('owner-token','prj_one',f.input),old=(await f.store.read('project-runtimes','prj_one:helper')).value.actor;
 await f.runtime.configure('owner-token','prj_one',{...f.input,expectedRevision:r.revision,enabled:false});
 assert.equal(await f.identity.allowed(old,'artifact.write',{projectId:'prj_one'}),false);
 const grants=await f.store.list('mandates',{});assert(grants.every(x=>x.value.revokedAt));
 const current=(await f.store.read('project-runtimes','prj_one:helper')).value;assert.equal(current.state,'paused');assert.equal(current.enabled,false);
}finally{await f.store.close();}});
test('initially disabled configuration creates no active internal credential',async()=>{const f=await fixture();try{
 const r=await f.runtime.configure('owner-token','prj_one',{...f.input,enabled:false});
 assert.equal((await f.store.list('mandates',{})).length,0);
 await f.runtime.configure('owner-token','prj_one',{...f.input,expectedRevision:r.revision});
 assert.equal((await f.store.list('mandates',{})).length,1);
}finally{await f.store.close();}});
test('a final action runs once and then completes and revokes the runtime',async()=>{const f=await fixture({state:{done:true},done:true,action:{operation:'data_file_write',input:{name:'result.json',content:'{}'}}});try{
 await f.runtime.configure('owner-token','prj_one',f.input);const actor=(await f.store.read('project-runtimes','prj_one:helper')).value.actor;
 await f.runtime.tick();f.advance(60000);await f.runtime.tick();await f.runtime.tick();
 const row=(await f.store.read('project-runtimes','prj_one:helper')).value;
 assert.equal(f.effects.length,1);assert.equal(row.cycle,1);assert.equal(row.enabled,false);assert.equal(row.state,'completed');assert.equal(row.pending,null);
 assert.equal(await f.identity.allowed(actor,'artifact.read',{projectId:'prj_one'}),false);
 f.advance(60000);await f.runtime.tick();assert.equal(f.effects.length,1);
}finally{await f.store.close();}});
test('completion without an action also revokes its internal access',async()=>{const f=await fixture();try{
 await f.runtime.configure('owner-token','prj_one',f.input);const actor=(await f.store.read('project-runtimes','prj_one:helper')).value.actor;
 await f.runtime.tick();f.advance(60000);await f.runtime.tick();
 assert.equal((await f.store.read('project-runtimes','prj_one:helper')).value.state,'completed');
 assert.equal(await f.identity.allowed(actor,'artifact.read',{projectId:'prj_one'}),false);
}finally{await f.store.close();}});
test('legacy inactive grants are retired by the normal scan without replaying pending work',async()=>{const f=await fixture();try{
 await f.runtime.configure('owner-token','prj_one',f.input);let row=await f.store.read('project-runtimes','prj_one:helper');const actor=row.value.actor;
 const pending={kind:'action',operation:'data_file_write',sending:true,input:{name:'original',content:'held'}};
 await f.store.transaction(tx=>tx.write('project-runtimes','prj_one:helper',{...row.value,enabled:false,state:'unknown',pending},row.revision));
 await f.runtime.tick();row=await f.store.read('project-runtimes','prj_one:helper');
 assert.equal(await f.identity.allowed(actor,'artifact.read',{projectId:'prj_one'}),false);assert.deepEqual(row.value.pending,pending);assert.equal(row.value.state,'unknown');assert.equal(f.effects.length,0);
}finally{await f.store.close();}});
test('a retried final write keeps the original key and only completes after confirmation',async()=>{const f=await fixture({state:{done:true},done:true,action:{operation:'data_file_write',input:{name:'result.json',content:'{}'}}});try{
 await f.runtime.configure('owner-token','prj_one',f.input);
 await f.runtime.tick();f.advance(60000);await f.runtime.tick();f.failNext('data_write_unknown');await f.runtime.tick();
 let row=await f.store.read('project-runtimes','prj_one:helper');assert.equal(row.value.enabled,true);assert.equal(row.value.pending.completeAfter,true);assert.equal(row.value.state,'waiting');
 f.advance(15000);await f.runtime.tick();row=await f.store.read('project-runtimes','prj_one:helper');
 assert.equal(f.effects.length,2);assert.equal(f.effects[0].input.idempotencyKey,f.effects[1].input.idempotencyKey);assert.equal(row.value.enabled,false);assert.equal(row.value.pending,null);assert.equal(row.value.cycle,1);
}finally{await f.store.close();}});
