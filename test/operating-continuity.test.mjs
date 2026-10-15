import test from 'node:test';import assert from 'node:assert/strict';
import {openStore} from '../src/storage/index.mjs';import {createRuntimes} from '../src/runtimes/index.mjs';import {createIdentity} from '../src/identity/index.mjs';import {digest} from '../src/shared/index.mjs';import {ROUTES} from '../interfaces/contract.mjs';import {computeUsage} from '../src/inference/usage.mjs';import {createWorkConnections} from '../src/collaboration/connections.mjs';
async function setup(t,maxCycles=10){
 const store=openStore(':memory:');t.after(()=>store.close());let at=1800000000000,runCount=0;
 const identity=createIdentity({store,now:()=>at});
 await store.transaction(async tx=>{await tx.write('projects','p',{id:'p',ownerId:'owner'},0);await tx.write('credentials','owner',{kind:'owner',principalId:'owner',expiresAt:at+3600000},0);await tx.write('project-workers','p:brain',{enabled:true},0);});
 let result={state:{done:1},done:true};
 const workers={get:async()=>({revision:1,enabled:true}),discovery:async()=>({enabled:true}),run:async(actor,projectId,input)=>{runCount++;const id=digest({projectId,idempotencyKey:input.idempotencyKey});await store.transaction(tx=>tx.write('worker-runs',id,{id,projectId,workerId:input.workerId,definitionRevision:1,state:'completed',resultJson:JSON.stringify(result)},0));return{id};},runGet:async(actor,projectId,id)=>{await identity.authorize(actor,'worker.read',{projectId});const r=await store.read('worker-runs',id);return{...r.value,result:JSON.parse(r.value.resultJson)};}};
 const api=createRuntimes({store,identity,workers,now:()=>at,route:n=>ROUTES.find(r=>r.name===n),execute:async()=>({ok:true})});
 await api.configure('owner','p',{runtimeId:'job',workerId:'brain',workerRevision:1,intervalSeconds:60,maxCycles,initialState:{},enabled:true,expectedRevision:0});
 return{store,identity,api,next:()=>{at+=61000;},count:()=>runCount,output:x=>{result=x;},get:()=>api.get('owner','p','job')};
}
test('owner resumes the original completed worker after a stop, without rerun or resurrecting the old key',async t=>{
 const f=await setup(t);await f.api.tick();const before=await f.get(),old=(await f.store.read('project-runtimes','p:job')).value.actor;
 await f.api.stop('owner','p','job',{expectedRevision:before.revision});const paused=await f.get();
 const resumed=await f.api.reconcile('owner','p','job',{expectedRevision:paused.revision});assert.deepEqual(resumed.pending,paused.pending);assert.equal(resumed.cycle,0);
 assert.equal(await f.identity.allowed(old,'worker.run',{projectId:'p'}),false);await f.api.tick();const done=await f.get();assert.equal(done.state,'completed');assert.equal(done.cycle,1);assert.equal(f.count(),1);assert.deepEqual(done.memory,{done:1});
 await assert.rejects(f.api.reconcile('owner','p','job',{expectedRevision:paused.revision}),{code:'revision_conflict'});
});
test('unknown original worker and sent non-idempotent action stay held',async t=>{
 const f=await setup(t);await f.api.tick();let r=await f.get();await f.api.stop('owner','p','job',{expectedRevision:r.revision});r=await f.get();
 await f.store.transaction(async tx=>{const row=await tx.read('worker-runs',r.pending.id);await tx.write('worker-runs',r.pending.id,{...row.value,state:'unknown'},row.revision);});
 await assert.rejects(f.api.reconcile('owner','p','job',{expectedRevision:r.revision}),{code:'runtime_original_not_resolved'});
 const before=await f.store.read('project-runtimes','p:job');await f.store.transaction(tx=>tx.write('project-runtimes','p:job',{...before.value,pending:{kind:'action',operation:'project_web_read',input:{projectId:'p',url:'https://example.com'},sending:true,idempotent:true}},before.revision));
 r=await f.get();await assert.rejects(f.api.reconcile('owner','p','job',{expectedRevision:r.revision}),{code:'runtime_original_not_resolved'});assert.equal(f.count(),1);
});
test('cycle exhaustion is terminal but distinct from task acceptance',async t=>{
 const f=await setup(t,1);f.output({state:{phase:'observed'}});await f.api.tick();f.next();await f.api.tick();const result=await f.get();assert.equal(result.enabled,false);assert.equal(result.state,'completed');assert.equal(result.completionReason,'cycle_limit');f.next();await f.api.tick();assert.equal(f.count(),1);assert.equal(result.receipt,undefined);
});
test('compute usage retains spent and unresolved expired commitments',async t=>{
 const store=openStore(':memory:');t.after(()=>store.close());await store.transaction(async tx=>{await tx.write('inference-allowances','a',{profileId:'p',limit:'600',reserved:'200',spent:'150',enabled:true,expiresAt:5},0);await tx.write('inference-allowances','b',{profileId:'p',limit:'300',reserved:'0',spent:'20',enabled:true,expiresAt:100},0);});
 const u=await computeUsage(store,{profileId:'p',allocated:'900'},50);assert.equal(u.reserved,'200');assert.equal(u.spent,'170');assert.equal(u.expiredUnspent,'250');assert.equal(u.unspentAllocated,'530');assert.equal(u.active,1);assert.equal(u.consistent,true);assert.equal((await store.read('inference-allowances','a')).revision,1);
});
test('work edges require public receipt and public agent; outage remains unknown',async t=>{
 const store=openStore(':memory:');t.after(()=>store.close());await store.transaction(async tx=>{await tx.write('principals','agent',{projectId:'child'},0);await tx.write('projects','child',{id:'child',slug:'child'},0);await tx.write('project-public-agents','child:agent',{published:true},0);await tx.write('public-projects','child',{published:true,projectId:'child'},0);});
 const project={projectId:'board',application:{manifest:{tasks:{visibility:'public'}}}},apps={records:async()=>({items:[{id:'task',assigneeId:'agent',authorId:'buyer',receipt:{id:'receipt'}}],nextCursor:null})};
 const connections=createWorkConnections({store,apps,visible:async()=>true});const visible=await connections(project);assert.equal(visible.edges.length,1);assert.equal(visible.edges[0].relation,'accepted_work');assert.equal(visible.edges[0].payment,undefined);
 await store.transaction(async tx=>{const p=await tx.read('project-public-agents','child:agent');await tx.write('project-public-agents','child:agent',{published:false},p.revision);});assert.equal((await connections(project)).edges.length,0);
 apps.records=async()=>{throw Error('offline');};assert.equal((await connections(project)).state,'unavailable');assert.equal((await connections({projectId:'private'})).state,'not_applicable');
});
