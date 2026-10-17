import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/storage/index.mjs';
import {createBilling,balance} from '../src/billing/index.mjs';
import {createInfrastructure} from '../src/infrastructure/index.mjs';
import {digest} from '../src/shared/index.mjs';
import {ROUTES,validate} from '../interfaces/contract.mjs';

async function fixture(t,{lostCreate=false}={}) {
  const store=openStore(':memory:');t.after(()=>store.close());let at=1000000,calls=0,active=true,observed=null;
  const identity={credential:async a=>{assert.equal(a,'owner');return {kind:'owner',principalId:'person'};},authorize:async(a,action,{projectId})=>{if(a!=='owner'||projectId!=='project'||(!active&&action==='infrastructure.manage'))throw Object.assign(Error('scope_denied'),{code:'scope_denied'});}};
  await store.transaction(async tx=>{await tx.write('principals','person',{chainId:1,address:'0xowner'},0);await tx.write('network','authority',{ownerAddress:'0xowner'},0);await tx.write('projects','project',{ownerId:'person'},0);});
  const ports={verifyRelease:async()=>true,verifyReceipt:async()=>true,
    quote:async r=>({id:'quote',requestHash:r.requestHash,accountId:'account',asset:'USDC',maximum:'100',expiresAt:at+60000,totalLifecycle:true}),
    create:async w=>{calls++;observed={operationId:w.id,accountId:'account',providerResourceId:'instance',ready:true,terminal:false};if(lostCreate)throw Error('network response lost');return observed;},
    inspect:async()=>observed,
    stop:async w=>({operationId:w.id,accountId:'account',providerResourceId:'instance',terminal:true,ready:false,receipt:{id:'bill:'+w.id,resourceId:w.id,accountId:'account',asset:'USDC',final:true,actual:'30'}}),
    logs:async()=>''};
  const api=createInfrastructure({store,identity,now:()=>at,ports,enabled:true});
  const profile={id:'cpu',enabled:true,provider:'fly',accountId:'account',asset:'USDC',fundingAccount:'fund',permissionHash:digest('authority'),maxLeaseSeconds:3600,maxPerLease:'100',maxActive:2,imagePrefixes:['ghcr.io/contractclaus/'],regions:['ams'],maxCpu:2,maxMemoryMiB:1024,maxStorageGiB:0,gpuTypes:[]};
  await api.setProfile('owner',{profile,expectedRevision:0});await api.setGrant('owner','project',{profileId:'cpu',enabled:true,expiresAt:at+86400000,limit:'500',expectedRevision:0});
  await createBilling({store,authorize:async()=>true,now:()=>at}).recordFunding({actor:'owner',account:'fund',asset:'USDC',amount:'500',receiptId:'real-test-fixture-only'});
  const manifest={version:1,mode:'http',image:'ghcr.io/contractclaus/app@sha256:'+'a'.repeat(64),region:'ams',cpu:1,memoryMiB:256,gpu:null,port:8080,healthPath:'/health',command:['node','server.mjs'],storageGiB:0,releaseHash:digest('release')};
  const quote=()=>api.quote('owner','project',{profileId:'cpu',manifest,leaseSeconds:300,idempotencyKey:'quote-key'});
  return {api,store,ports,identity,profile,manifest,quote,advance:n=>at+=n,revoke:()=>active=false,calls:()=>calls,balance:()=>balance(store,'fund','USDC')};
}

test('one quote and idempotency key reserve once; another key cannot reuse the quote',async t=>{
  const f=await fixture(t),q=await f.quote(),input={quoteId:q.id,idempotencyKey:'create'};
  const [a,b]=await Promise.all([f.api.request('owner','project',input),f.api.request('owner','project',input)]);
  assert.equal(a.id,b.id);assert.equal((await f.balance()).reserved,'100');
  await assert.rejects(f.api.request('owner','project',{...input,idempotencyKey:'duplicate'}),{code:'infrastructure_quote_already_used'});
  await assert.rejects(f.api.get('stranger','project',a.id),{code:'scope_denied'});
});

test('lost create response retains reservation and recovers the original resource without another create',async t=>{
  const f=await fixture(t,{lostCreate:true}),q=await f.quote(),r=await f.api.request('owner','project',{quoteId:q.id,idempotencyKey:'create'});
  await f.api.reconcile(r.id);assert.equal((await f.api.get('owner','project',r.id)).state,'unknown');assert.equal((await f.balance()).reserved,'100');
  await f.api.reconcile(r.id);assert.equal(f.calls(),1);const live=await f.api.get('owner','project',r.id);assert.equal(live.state,'running');
  await f.api.stop('owner','project',r.id,{expectedRevision:live.revision});await f.api.reconcile(r.id);
  assert.deepEqual(await f.balance(),{account:'fund',asset:'USDC',available:'470',reserved:'0',spent:'30'});
  await f.api.reconcile(r.id);assert.equal(f.calls(),1);assert.equal((await f.balance()).spent,'30');
});

test('revocation before dispatch cancels without provider I/O and returns only the unsent reservation',async t=>{
  const f=await fixture(t),q=await f.quote(),r=await f.api.request('owner','project',{quoteId:q.id,idempotencyKey:'create'});
  f.revoke();await f.api.reconcile(r.id);assert.equal(f.calls(),0);assert.equal((await f.api.get('owner','project',r.id)).state,'cancelled');assert.equal((await f.balance()).available,'500');
});

test('a stopped provider without a final bill cannot release unknown costs',async t=>{
  const f=await fixture(t),q=await f.quote(),r=await f.api.request('owner','project',{quoteId:q.id,idempotencyKey:'create'});
  await f.api.reconcile(r.id);f.ports.inspect=async()=>({operationId:r.id,accountId:'account',providerResourceId:'instance',ready:false,terminal:true});
  await f.api.reconcile(r.id);assert.equal((await f.api.get('owner','project',r.id)).state,'stopped');assert.equal((await f.balance()).reserved,'100');
  await assert.rejects(f.api.update('owner','project',r.id,{quoteId:q.id,idempotencyKey:'replace',expectedRevision:(await f.api.get('owner','project',r.id)).revision}),{code:'resource_must_stop_and_settle'});
});

test('authority and manifests cannot silently change while reservations exist',async t=>{
  const f=await fixture(t),q=await f.quote();await f.api.request('owner','project',{quoteId:q.id,idempotencyKey:'create'});
  await assert.rejects(f.api.setProfile('owner',{profile:{...f.profile,maxPerLease:'999'},expectedRevision:1}),{code:'infrastructure_profile_immutable'});
  await assert.rejects(f.api.setGrant('owner','project',{profileId:'cpu',enabled:true,expiresAt:2000000,limit:'1',expectedRevision:2}),{code:'allowance_below_obligations'});
  await assert.rejects(f.api.quote('owner','project',{profileId:'cpu',manifest:{...f.manifest,image:'ghcr.io/contractclaus/app:latest'},leaseSeconds:300,idempotencyKey:'bad-image'}),{code:'immutable_image_required'});
  f.advance(61000);await f.api.tick();assert.equal(f.calls(),0);assert.equal((await f.balance()).reserved,'0');
});

test('API and MCP share all twelve resource contracts and reject undeclared permissions',()=>{
  assert.equal(new Set(ROUTES.map(r=>r.name)).size,ROUTES.length);
  const names=['resource_build_plan','resource_profiles','resource_instances','resource_quote','resource_request','resource_status','resource_logs','resource_stop','resource_delete','resource_update','resource_profile_set','resource_allowance_set'];
  for(const name of names)assert(ROUTES.some(r=>r.name===name));
  const route=ROUTES.find(r=>r.name==='resource_request');validate(route.inputSchema,{projectId:'project',quoteId:digest('quote'),idempotencyKey:'once'});
  assert.throws(()=>validate(route.inputSchema,{projectId:'project',quoteId:digest('quote'),idempotencyKey:'once',fundingAccount:'someone-else'}));
});

test('an expired credential tears down its running resource while preserving final accounting',async t=>{
 const f=await fixture(t),q=await f.quote(),r=await f.api.request('owner','project',{quoteId:q.id,idempotencyKey:'create'});
 await f.api.reconcile(r.id);
 f.identity.authorize=async()=>{throw Object.assign(Error('unauthenticated'),{code:'unauthenticated'});};
 let desired;const stop=f.ports.stop;f.ports.stop=async w=>{desired=w.desired;return stop(w);};
 await f.api.reconcile(r.id);assert.equal(desired,'deleted');assert.equal((await f.balance()).spent,'30');
});

test('release approval and quote expiry are checked again immediately before provider creation',async t=>{
 const f=await fixture(t),q=await f.quote(),r=await f.api.request('owner','project',{quoteId:q.id,idempotencyKey:'create'});
 f.ports.verifyRelease=async()=>{f.advance(61000);return true;};
 await f.api.reconcile(r.id);assert.equal(f.calls(),0);assert.equal((await f.balance()).reserved,'100');
 await f.api.reconcile(r.id);assert.equal((await f.balance()).reserved,'0');assert.equal(f.calls(),0);
});
