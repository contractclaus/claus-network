import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/storage/index.mjs';
import {createBilling,balance} from '../src/billing/index.mjs';
import {createInfrastructure} from '../src/infrastructure/index.mjs';
import {digest} from '../src/shared/index.mjs';
import {ROUTES,validate} from '../interfaces/contract.mjs';

async function fixture(t,{limit='10000',lostCreate=false,source={kind:'reported'}}={}){
 const store=openStore(':memory:');t.after(()=>store.close());let at=1000000,creates=0,permitted=true;
 const actual=new Map();
 const identity={credential:async()=>({kind:'owner',principalId:'claus'}),authorize:async a=>{assert.equal(a,'owner');if(!permitted)throw Object.assign(Error('scope_denied'),{code:'scope_denied'});},ongoingInfrastructureAllowed:async()=>permitted};
 await store.transaction(async tx=>{
  await tx.write('principals','claus',{chainId:1,address:'0x59edf6152080e847e5ea15f9ae6a77c1f03c44f5'},0);
  await tx.write('network','authority',{ownerAddress:'0x59edf6152080e847e5ea15f9ae6a77c1f03c44f5'},0);
  await tx.write('network-capabilities','continuous-operation',{enabled:true,profile:'claus-operation-v1',expiresAt:null},0);
  await tx.write('projects','project',{ownerId:'claus'},0);
 });
 const ports={verifyRelease:async()=>true,verifyReceipt:async()=>true,
  quote:async i=>({id:digest(i),requestHash:i.requestHash,accountId:'account',asset:'USDC',maximum:'1000',expiresAt:at+60000,totalLifecycle:true}),
  create:async w=>{creates++;const r={operationId:w.id,accountId:'account',providerResourceId:'vm-'+creates,ready:true,terminal:false,providerLeaseUntil:w.leaseUntil};actual.set(w.id,r);if(lostCreate){lostCreate=false;throw Error('response lost');}return r;},
  inspect:async w=>actual.get(w.id),extend:async w=>({...actual.get(w.id),providerLeaseUntil:w.leaseUntil}),
  stop:async w=>({operationId:w.id,accountId:'account',providerResourceId:actual.get(w.id)?.providerResourceId,ready:false,terminal:true,receipt:{id:'bill:'+w.id,resourceId:w.id,accountId:'account',asset:'USDC',final:true,actual:'500'}}),logs:async()=>'',
  queueLoad:async()=>({enabled:true,backlog:20,busy:0,observedAt:at})};
 const api=createInfrastructure({store,identity,now:()=>at,ports,enabled:true});
 const profile={id:'cpu',enabled:true,provider:'fly',accountId:'account',asset:'USDC',fundingAccount:'fund',permissionHash:digest('authority'),maxLeaseSeconds:3600,maxPerLease:'1000',maxActive:4,imagePrefixes:['ghcr.io/contractclaus/'],regions:['ams'],maxCpu:2,maxMemoryMiB:1024,maxStorageGiB:0,gpuTypes:[]};
 await api.setProfile('owner',{profile,expectedRevision:0});await api.setGrant('owner','project',{profileId:'cpu',enabled:true,expiresAt:at+86400000,limit,expectedRevision:0});
 await createBilling({store,authorize:async()=>true,now:()=>at}).recordFunding({actor:'owner',account:'fund',asset:'USDC',amount:limit,receiptId:'test-fixture'});
 const manifest={version:1,mode:'worker',image:'ghcr.io/contractclaus/app@sha256:'+'a'.repeat(64),region:'ams',cpu:1,memoryMiB:256,gpu:null,port:null,healthPath:null,command:['node','worker.mjs'],storageGiB:0,releaseHash:digest('release')};
 const input={name:'workers',expectedRevision:0,enabled:true,profileId:'cpu',manifest,source,minReplicas:0,maxReplicas:2,targetBacklog:10,scaleUpCooldownSeconds:30,scaleDownDelaySeconds:60,leaseSeconds:600,stateMode:'external-durable'};
 await api.autoscaling.configure('owner','project',input);
 return {api,store,ports,input,advance:n=>at+=n,revoke:()=>permitted=false,creates:()=>creates,
  sample:async(backlog,busy=0)=>api.autoscaling.signal('owner','project','workers',{sampleId:'sample-'+at,observedAt:at,backlog,busy}),
  state:async()=>api.autoscaling.get('owner','project','workers'),money:()=>balance(store,'fund','USDC'),tick:()=>api.autoscaling.tick()};
}

test('authenticated load scales replicas; quiet-period hysteresis drains through original billing',async t=>{
 const f=await fixture(t);await f.sample(20);await f.tick();await f.tick();await f.api.tick();
 assert.equal((await f.state()).state.members.length,1);assert.equal(f.creates(),1);
 f.advance(31000);await f.sample(20);await f.tick();await f.tick();await f.api.tick();
 assert.equal((await f.state()).state.members.length,2);assert.equal(f.creates(),2);assert.equal((await f.money()).reserved,'2000');
 f.advance(1000);await f.sample(0);await f.tick();f.advance(59000);await f.tick();
 assert.equal((await f.state()).state.members.length,2);
 f.advance(2000);await f.tick();await f.api.tick();await f.tick();await f.api.tick();await f.tick();
 assert.equal((await f.state()).state.members.length,0);assert.equal((await f.money()).spent,'1000');assert.equal(f.creates(),2);
});

test('concurrent reconciliation and an unknown provider response preserve one reserved replica',async t=>{
 const f=await fixture(t,{lostCreate:true});await f.sample(1);
 await Promise.all([f.tick(),f.tick()]);await Promise.all([f.tick(),f.tick()]);await f.api.tick();
 const first=(await f.state()).state.members[0];assert(first);assert.equal(f.creates(),1);
 f.advance(60000);await f.sample(1);await f.tick();await f.api.tick();
 assert.deepEqual((await f.state()).state.members,[first]);assert.equal(f.creates(),1);assert.equal((await f.money()).reserved,'1000');
});

test('stale signals cannot fund pending replicas, and policy revisions need fresh reported signals',async t=>{
 const f=await fixture(t);await f.sample(20);await f.tick();f.advance(301000);await f.tick();
 assert.equal((await f.state()).state.pending,null);assert.equal((await f.money()).reserved,'0');
 f.advance(1);await f.sample(20);const current=await f.state();await f.api.autoscaling.configure('owner','project',{...f.input,expectedRevision:current.revision,minReplicas:1});
 await f.tick();assert.equal((await f.state()).state.reason,'load_signal_stale');assert.equal((await f.money()).reserved,'0');
});

test('budget exhaustion keeps the existing replica and pending identity without another reservation',async t=>{
 const f=await fixture(t,{limit:'1000'});await f.sample(20);await f.tick();await f.tick();await f.api.tick();f.advance(31000);await f.sample(20);await f.tick();
 const pending=(await f.state()).state.pending.key;await f.tick();
 assert.equal((await f.state()).state.pending.key,pending);assert.equal((await f.state()).state.members.length,1);assert.equal((await f.money()).reserved,'1000');assert.equal(f.creates(),1);
});

test('revoked work drains existing replicas; a live queue source is checked inside custody',async t=>{
 const f=await fixture(t,{source:{kind:'owned-queue',queueId:'res_'+'1'.repeat(24),workId:'nw_task'}});await f.tick();await f.tick();await f.api.tick();
 f.ports.queueLoad=async()=>({enabled:false,backlog:0,busy:0,observedAt:1000000});
 // The callback is already bound to the initial port; explicit identity revocation must still drain.
 f.revoke();await f.tick();await f.api.tick();const rows=await f.store.list('infrastructure-resources',{projectId:'project',limit:10});
 assert.equal(rows.length,1);assert.equal(rows[0].value.terminal,true);assert.equal(rows[0].value.desired,'deleted');assert.equal((await f.money()).spent,'500');
});

test('autoscaling renews the original lease and exposes matching API schemas',async t=>{
 const f=await fixture(t);await f.sample(1);await f.tick();await f.tick();await f.api.tick();const original=(await f.state()).state.members[0];
 f.advance(301000);await f.sample(1);await f.tick();await f.tick();await f.api.tick();
 assert.equal(f.creates(),1);assert.deepEqual((await f.state()).state.members,[original]);assert.equal((await f.money()).reserved,'2000');
 const route=ROUTES.find(r=>r.name==='resource_scaling_set');assert(route);validate(route.inputSchema,{projectId:'project',...f.input});
 await assert.rejects(f.api.autoscaling.configure('owner','project',{...f.input,expectedRevision:1,stateMode:'local-disk'}),{code:'autoscaling_external_state_required'});
});

test('early replica failures retain the cause and cool down before a replacement',async t=>{
 const f=await fixture(t);await f.sample(1);await f.tick();await f.tick();await f.api.tick();
 const id=(await f.state()).state.members[0];
 await f.store.transaction(async tx=>{const r=await tx.read('infrastructure-resources',id);await tx.write('infrastructure-resources',id,{...r.value,terminal:true,state:'stopped',error:'gpu_out_of_memory'},r.revision);});
 await f.tick();const state=(await f.state()).state;
 assert.equal(state.launchFailures,1);assert.equal(state.lastLaunchFailure.error,'gpu_out_of_memory');assert.equal(state.pending,null);
});
