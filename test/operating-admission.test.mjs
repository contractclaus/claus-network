import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryAppStore} from '../src/app-storage/index.mjs';
import {openStore} from '../src/storage/index.mjs';
import {operatingProject} from '../src/operating-access/index.mjs';
import {createReviewAdmission} from '../src/review-flow/admission.mjs';
import {publicDecisionCapacity} from '../src/approvals/limits.mjs';
import {createOciBuilds} from '../src/infrastructure/builds.mjs';
import {createArtifactStore} from '../src/artifact-store/index.mjs';
import {createJobs} from '../src/jobs/index.mjs';
import {reserve} from '../src/billing/index.mjs';
import {digest} from '../src/shared/index.mjs';
import {fixture} from './apps-fixture.mjs';

async function enable(store, projectId='own', ownerId='claus') {
  await store.transaction(async tx=>{
    await tx.write('network-capabilities','continuous-operation',{enabled:true,profile:'claus-operation-v1',expiresAt:null},0);
    if(projectId==='own') {
      await tx.write('principals',ownerId,{chainId:1,address:'0x59edf6152080e847e5ea15f9ae6a77c1f03c44f5'},0);
      await tx.write('projects',projectId,{id:projectId,ownerId},0);
    }
  });
}

test('operating admission follows actual ownership and current operation grant',async t=>{
  const s=openStore(':memory:');t.after(()=>s.close());await enable(s);
  assert.equal(await operatingProject(s,'own'),true);
  await s.transaction(async tx=>{
    await tx.write('principals','stranger',{chainId:1,address:'0x'+'11'.repeat(20)},0);
    await tx.write('projects','imitation',{name:'Claus',ownerId:'stranger'},0);
  });
  assert.equal(await operatingProject(s,'imitation'),false);
  await s.transaction(async tx=>{const r=await tx.read('projects','own');await tx.write('projects','own',{...r.value,transfer:{pending:true}},r.revision);});
  assert.equal(await operatingProject(s,'own'),false);
});

test('own reviews keep public counts intact and still reserve real available funds atomically',async t=>{
  const s=openStore(':memory:');t.after(()=>s.close());await enable(s);
  const now=1800000000000,admission=createReviewAdmission({store:s,networkOwner:async()=>{},now:()=>now});
  const config={kind:'operating',perOwnerDay:2,maximumLifetime:'10'};
  await s.transaction(async tx=>{
    await tx.write('public-review-exposure','lifetime',{maximum:'10'},0);
    await tx.write('public-review-owner-admission',digest({ownerId:'claus',day:Math.floor(now/86400000)}),{count:2},0);
    await tx.write('balances',digest({account:'sponsor',asset:'IMD'}),{account:'sponsor',asset:'IMD',available:'5',reserved:'0',spent:'0'},0);
  });
  const submit=id=>s.transaction(async tx=>{await admission.reserve(tx,'own','5',config,id);await reserve(tx,'sponsor','IMD','5');});
  await submit('original');
  await assert.rejects(submit('cannot-afford'),{code:'funding_insufficient'});
  assert.equal(await s.read('public-review-reservations','cannot-afford'),null);
  assert.equal((await s.read('public-review-exposure','lifetime')).value.maximum,'10');
  assert.equal((await s.read('operating-review-exposure','lifetime')).value.maximum,'5');
  await assert.rejects(submit('original'),{code:'idempotency_conflict'});
  await s.transaction(async tx=>{await tx.write('review-jobs','original',{work:'cancelled',billing:'void'},0);await admission.releaseUnsent(tx,'original');});
  assert.equal((await s.read('operating-review-exposure','lifetime')).value.maximum,'0');
  assert.equal((await s.read('public-review-exposure','lifetime')).value.maximum,'10');
  await assert.rejects(s.transaction(tx=>admission.reserve(tx,'own','5',{...config,kind:'public'},'public')),{code:'capacity_reached'});
});

test('own decision counts do not impose a day wait or consume public counts',async t=>{
  const s=openStore(':memory:');t.after(()=>s.close());await enable(s);const now=1800000000000;
  for(let i=0;i<10;i++)await s.transaction(tx=>publicDecisionCapacity(tx,'own',now,true));
  for(let i=0;i<2;i++)await s.transaction(tx=>publicDecisionCapacity(tx,'stranger',now,true));
  await assert.rejects(s.transaction(tx=>publicDecisionCapacity(tx,'stranger',now,true)),{code:'decision_capacity_reached'});
});

test('own container builds reuse real capacity, but unresolved builds cannot be replaced',async t=>{
  const s=openStore(':memory:');t.after(()=>s.close());await enable(s);let now=1000000,calls=0;
  const identity={authorize:async()=>{},allowed:async()=>true};
  const jobs=createJobs({store:s,identity,now:()=>now}),artifacts=createArtifactStore({store:s});
  const api=createOciBuilds({store:s,identity,jobs,artifacts,enabled:true,now:()=>now,projects:{publicSource:async()=>({projectId:'own',snapshotId:'s',files:[{path:'Dockerfile',content:'FROM scratch'}]})},ports:{dispatch:async v=>{calls++;return {buildId:v.id,state:'running'};},inspect:async v=>({buildId:v.id,state:'compiled',receipt:{buildId:v.id,projectId:v.projectId,planId:v.planId,sourceHash:v.sourceHash,imageDigest:digest('image'),archiveHash:digest('archive'),archiveBytes:20,evidence:'compiled_only'}}),verify:async()=>true}});
  for(let i=0;i<4;i++) {
    const b=await api.submit('owner','own',{snapshotId:'s',publishSource:true,idempotencyKey:String(i)});
    await assert.rejects(api.submit('owner','own',{snapshotId:'s',publishSource:true,idempotencyKey:'duplicate-pending'}),{code:'oci_build_capacity_reached'});
    await api.runOne();now+=61000;await api.runOne();assert.equal((await api.get('owner','own',b.id)).state,'compiled');
  }
  assert.equal(calls,4);
});

test('own project creation is not capped at ten, while foreign projects retain limits',async t=>{
  const f=await fixture(t);await enable(f.store,f.project.id);
  const who=await f.owner.call('principal_me');
  await f.store.transaction(async tx=>{const key=digest({kind:'projects',subject:who.principal.id}),old=await tx.read('identity-capacity',key);await tx.write('identity-capacity',key,{kind:'projects',count:100},old?.revision??0);});
  const p=await f.owner.call('project_create',{name:'Another useful project',slug:'another-project',idempotencyKey:'next'});
  assert(p.id);
});

test('own app writes pass exhausted public counters; member writes still cannot',async t=>{
  const store=openStore(':memory:');t.after(()=>store.close());const storage=memoryAppStore(store);
  const f=await fixture(t,{store,appStorage:storage});await enable(f.store,f.project.id);
  await storage.transaction(f.project.id,async tx=>{const old=await tx.read('meta','usage');await tx.write('meta','usage',{day:Math.floor(Date.now()/86400000),count:1000},old.revision);});
  const input={projectId:f.project.id,collection:'posts',data:{text:'real work'},idempotencyKey:'own-write'};
  const first=await f.owner.call('app_record_create',input);
  assert.equal((await f.owner.call('app_record_create',input)).id,first.id);
  await assert.rejects(f.bob.call('app_record_create',{...input,idempotencyKey:'public-write'}),/capacity_reached/);
  assert.equal((await storage.reader(f.project.id).read('meta','usage')).value.count,1000);
});

test('own snapshots and releases continue beyond historical version counts',async t=>{
 const f=await fixture(t);await enable(f.store,f.project.id);const projectId=f.project.id;
 await f.store.transaction(async tx=>{
  for(const collection of ['snapshot-capacity','release-capacity']) {
   const r=await tx.read(collection,projectId);await tx.write(collection,projectId,{...r?.value,count:9000,bytes:0},r?.revision??0);
  }
 });
 const p=await f.owner.call('project_get',{projectId});
 const s=await f.owner.call('snapshot_create',{projectId,expectedProjectRevision:p.revision,files:[{path:'index.html',content:'<h1>Next version</h1>'}]});
 const r=await f.owner.call('release_create',{projectId,snapshotId:s.id,paths:['index.html']});assert(r.id);
});

test('own workers do not inherit exhausted public daily counters and retain exact request recovery',async t=>{
 let calls=0;const f=await fixture(t,{workersEnabled:true,workerPorts:{execute:async()=>{calls++;return{output:'{"ok":true}',exitCode:0};},stop:async()=>{}}});
 await enable(f.store,f.project.id);const projectId=f.project.id;
 await f.store.transaction(async tx=>{
  await tx.write('network-capabilities','workers',{enabled:true},0);
  for(const subject of [projectId,'global']) await tx.write('worker-daily',subject+':'+Math.floor(Date.now()/86400000),{count:1000},0);
 });
 const p=await f.owner.call('project_get',{projectId}),s=await f.owner.call('snapshot_create',{projectId,expectedProjectRevision:p.revision,files:[{path:'main.mjs',content:'export default ()=>({ok:true})'}]});
 const d=await f.owner.call('worker_configure',{projectId,workerId:'work',snapshotId:s.id,entry:'main.mjs',paths:['main.mjs'],expectedRevision:0});
 const input={projectId,workerId:'work',expectedRevision:d.revision,input:{},idempotencyKey:'original'};
 const r=await f.owner.call('worker_run',input);await f.app.workers.tick();assert.equal((await f.owner.call('worker_run',input)).id,r.id);assert.equal(calls,1);
});
