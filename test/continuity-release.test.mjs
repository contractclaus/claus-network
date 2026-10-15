import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,manifest} from './apps-fixture.mjs';
import {openStore} from '../src/storage/index.mjs';import {createIdentity} from '../src/identity/index.mjs';import {createRuntimes} from '../src/runtimes/index.mjs';
import {ROUTES} from '../interfaces/contract.mjs';import {bindAction,recoveryFor} from '../src/runtimes/action-broker.mjs';import {digest} from '../src/shared/index.mjs';

test('optional schema evolution preserves existing records, authors and historical versions; rejects destructive changes',async t=>{
 const {owner,bob,project}=await fixture(t),projectId=project.id;
 const before=await bob.call('app_record_create',{projectId,collection:'posts',data:{text:'original'},idempotencyKey:'one'});
 let app=await owner.call('app_get',{projectId});const next=JSON.parse(JSON.stringify(manifest));next.collections[0].schema.properties.label={type:'string',maxLength:30};
 const request={projectId,manifest:next,expectedRevision:app.revision,idempotencyKey:'add-optional'};
 app=await owner.call('app_configure',request);assert.deepEqual(await owner.call('app_configure',request),app);
 assert.deepEqual((await bob.call('app_records',{projectId,collection:'posts'})).items[0],before);
 const posted=await bob.call('app_record_create',{projectId,collection:'posts',data:{text:'new',label:'tag'},idempotencyKey:'two'});assert.equal(posted.data.label,'tag');
 let badKey=0;for(const change of [m=>m.collections[0].schema.required.push('label'),m=>m.collections[0].visibility='public'===m.collections[0].visibility?'members':'public',m=>{delete m.collections[0].schema.properties.text;m.collections[0].schema.required=[];},m=>m.tasks.leaseSeconds=3600]){
  const bad=structuredClone(next);change(bad);await assert.rejects(owner.call('app_configure',{projectId,manifest:bad,expectedRevision:app.revision,idempotencyKey:'bad'+badKey++}),{code:'app_schema_migration_required'});
 }
 const after=await owner.call('app_get',{projectId});assert.equal(after.version,app.version);assert.equal(after.schemaEvolution.recordsRewritten,false);
});
test('workflow target validates a real input without referring to undefined brief state',async t=>{
 const {owner,app,store,project}=await fixture(t);const me=await owner.call('principal_me');
 const actor=(await store.list('credentials',{limit:100})).find(r=>r.value.principalId===me.principal.id&&r.value.kind==='owner').id;
 const target=await app.apps.workflowTarget(actor,project.id,{input:{text:'work'}});assert.equal(target.schemaHash,digest(manifest.tasks));
 await assert.rejects(app.apps.workflowTarget(actor,project.id,{input:{unknown:true}}),{code:'service_schema_mismatch'});
});
async function runtimeFixture(t){
 const store=openStore(':memory:');t.after(()=>store.close());let now=1800000000000,calls=0,effects=0;
 const identity=createIdentity({store,domain:'claus.si',now:()=>now,verifySignature:()=>true});
 await store.transaction(async tx=>{await tx.write('projects','p',{id:'p',ownerId:'owner',archivedAt:null},0);await tx.write('credentials','owner',{id:'owner',kind:'owner',principalId:'owner',expiresAt:now+3600000},0);});
 const keys=new Set();const worker={id:'original',state:'completed',result:{state:{phase:'written'},action:{operation:'app_record_create',input:{projectId:'p',collection:'records',data:{a:1},idempotencyKey:'model-chosen'}}}};
 const params={store,identity,now:()=>now,route:name=>ROUTES.find(r=>r.name===name),workers:{get:async()=>({revision:1,enabled:true}),run:async()=>worker,runGet:async()=>worker},execute:async(name,input,actor)=>{await identity.authorize(actor,'app.use',{projectId:'p'});calls++;if(!keys.has(input.idempotencyKey)){keys.add(input.idempotencyKey);effects++;throw Object.assign(Error('ack lost'),{code:'network_failure'});}return {id:'original-record'};}};
 let api=createRuntimes(params);await api.configure('owner','p',{runtimeId:'work',workerId:'brain',workerRevision:1,intervalSeconds:60,maxCycles:10,initialState:{},enabled:true,expectedRevision:0});
 return {store,get api(){return api;},restart:()=>api=createRuntimes(params),advance:n=>now+=n,counts:()=>({calls,effects})};
}
test('a lost acknowledgment resumes exactly one original effect after host restart',async t=>{
 const f=await runtimeFixture(t);await f.api.tick();f.advance(61000);await f.api.tick();await f.api.tick();
 const waiting=await f.api.get('owner','p','work');assert.equal(waiting.state,'waiting');assert.equal(waiting.pending.recoveryAttempts,1);assert.equal(waiting.enabled,true);
 f.restart();f.advance(16000);await f.api.tick();const done=await f.api.get('owner','p','work');assert.equal(done.cycle,1);assert.equal(done.pending,null);assert.deepEqual(f.counts(),{calls:2,effects:1});
});
test('an explicit stop remains revoked while an original retry is pending',async t=>{
 const f=await runtimeFixture(t);await f.api.tick();f.advance(61000);await f.api.tick();await f.api.tick();const before=await f.api.get('owner','p','work');
 await f.api.stop('owner','p','work',{expectedRevision:before.revision});f.advance(60000);f.restart();await f.api.tick();assert.deepEqual(f.counts(),{calls:1,effects:1});
 const after=await f.api.get('owner','p','work');assert.equal(after.enabled,false);assert.deepEqual(after.pending,before.pending);await f.store.transaction(async tx=>{const p=await tx.read('projects','p');await tx.write('projects','p',{...p.value,archivedAt:1},p.revision);});await assert.rejects(f.api.reconcile('owner','p','work',{expectedRevision:after.revision}));assert.deepEqual(f.counts(),{calls:1,effects:1});
});
test('broker rejects invented authority and refuses unknown financial effects and changed keys',async()=>{
 const route=name=>ROUTES.find(r=>r.name===name),id='p:work',cycleKey='runtime:'+digest({id,cycle:0}).slice(7);
 assert.throws(()=>bindAction({operation:'compute_grant_set',input:{}},{route,projectId:'p',cycleKey}),{code:'runtime_action_denied'});
 const input={profileId:'text',profileHash:digest('profile'),model:'m',input:'hello',maxOutputTokens:10};
 const pending=bindAction({operation:'inference_submit',input:{...input,projectId:'foreign',idempotencyKey:'bad'}},{route,projectId:'p',cycleKey});
 const work={projectId:'p',cycle:0,pending};assert.equal(pending.input.projectId,'p');
 const context={id,route,reader:{read:async()=>null},now:1};assert.equal((await recoveryFor(work,context)).allowed,false);
 const record={value:{requestHash:digest(input)}};context.reader.read=async()=>record;assert.equal((await recoveryFor(work,context)).allowed,true);
 pending.input.input='changed';assert.equal((await recoveryFor(work,context)).allowed,false);pending.input.input='hello';pending.recoveryAttempts=3;assert.equal((await recoveryFor(work,context)).allowed,false);
});
