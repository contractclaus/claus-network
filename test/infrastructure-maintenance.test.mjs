import test from 'node:test';import assert from 'node:assert/strict';
import {openStore} from '../src/storage/index.mjs';import {createBilling,balance} from '../src/billing/index.mjs';import {createInfrastructure} from '../src/infrastructure/index.mjs';import {digest} from '../src/shared/index.mjs';import {maintenanceDue} from '../src/infrastructure/maintenance.mjs';
async function fixture(t){
 const store=openStore(':memory:');t.after(()=>store.close());let now=1_000_000,active=true,login=true,creates=0,extensionsCount=0,quoteHook;
 const identity={credential:async()=>({kind:'owner',principalId:'owner'}),authorize:async(a,_s,{projectId})=>{if(!login||!active||a!=='owner'||projectId!=='project')throw Object.assign(Error('scope_denied'),{code:'scope_denied'});},ongoingInfrastructureAllowed:async()=>active};
 await store.transaction(async tx=>{await tx.write('principals','owner',{chainId:1,address:'0xowner'},0);await tx.write('network','authority',{ownerAddress:'0xowner'},0);await tx.write('projects','project',{ownerId:'owner'},0);});
 const seen=w=>({operationId:w.id,accountId:'account',providerResourceId:'same-provider',ready:true,terminal:false,providerLeaseUntil:w.leaseUntil});
 const ports={verifyRelease:async()=>active,quote:async r=>{if(quoteHook)await quoteHook();return{id:'quote-'+now,requestHash:r.requestHash,accountId:'account',asset:'USD',maximum:'100',expiresAt:now+60000,totalLifecycle:true}},create:async w=>{creates++;return seen(w)},inspect:async w=>seen(w),extend:async w=>{extensionsCount++;return seen(w)},stop:async w=>({...seen(w),ready:false,terminal:true})};
 const api=createInfrastructure({store,identity,ports,enabled:true,now:()=>now});const profile={id:'cpu',enabled:true,provider:'runpod',accountId:'account',asset:'USD',fundingAccount:'fund',permissionHash:digest('authorization'),maxLeaseSeconds:3600,maxPerLease:'100',maxActive:2,imagePrefixes:['registry.example/claus/'],regions:['AMS'],maxCpu:2,maxMemoryMiB:2048,maxStorageGiB:0,gpuTypes:[]};
 await api.setProfile('owner',{profile,expectedRevision:0});await api.setGrant('owner','project',{profileId:'cpu',enabled:true,expiresAt:now+86400000,limit:'1000',expectedRevision:0});await createBilling({store,authorize:async()=>true,now:()=>now}).recordFunding({actor:'owner',account:'fund',asset:'USD',amount:'1000',receiptId:'fixture'});
 const manifest={version:1,mode:'http',image:'registry.example/claus/app@sha256:'+'a'.repeat(64),region:'AMS',cpu:1,memoryMiB:256,gpu:null,port:8080,healthPath:'/health',command:[],storageGiB:0,releaseHash:digest('review')};
 const q=await api.quote('owner','project',{profileId:'cpu',manifest,leaseSeconds:300,idempotencyKey:'original-quote'}),r=await api.request('owner','project',{quoteId:q.id,idempotencyKey:'original-resource'});await api.reconcile(r.id);
 const policy={until:now+3600000,leaseSeconds:300,renewBeforeSeconds:120,maxTotalCost:'500'};
 return{api,store,ports,identity,r,policy,read:()=>api.get('owner','project',r.id),enable:async p=>api.maintain('owner','project',r.id,{expectedRevision:(await api.get('owner','project',r.id)).revision,policy:p??policy}),advance:n=>now+=n,expireLogin:()=>login=false,revoke:()=>active=false,onQuote:f=>quoteHook=f,counts:()=>({creates,extensionsCount}),balance:()=>balance(store,'fund','USD')};
}
test('finite maintenance renews the same resource after owner login expires, exactly once',async t=>{
 const f=await fixture(t);await f.enable();f.advance(100000);await f.api.reconcile(f.r.id);assert.equal(f.counts().extensionsCount,0);
 f.advance(100000);f.expireLogin();await f.api.reconcile(f.r.id);await f.api.reconcile(f.r.id);
 assert.deepEqual(f.counts(),{creates:1,extensionsCount:1});assert.equal((await f.balance()).reserved,'200');
 const v=(await f.store.read('infrastructure-resources',f.r.id)).value;assert.equal(v.providerLeaseUntil,v.leaseUntil);assert.equal(v.renewalPending,false);
 await assert.rejects(f.read(),{code:'scope_denied'});
});
test('resource spending cap blocks renewal without turning the healthy service into an unknown outcome',async t=>{
 const f=await fixture(t);await f.enable({...f.policy,maxTotalCost:'100'});f.advance(200000);await f.api.reconcile(f.r.id);
 const v=await f.read();assert.equal(v.state,'running');assert.equal(v.maintenance.last.code,'maintenance_budget_exhausted');assert.equal(f.counts().extensionsCount,0);assert.equal((await f.balance()).reserved,'100');
});
test('explicit stop and revoked authority cannot be revived by maintenance',async t=>{
 const f=await fixture(t);await f.enable();const v=await f.read();await f.api.stop('owner','project',v.id,{expectedRevision:v.revision});f.advance(200000);await f.api.reconcile(v.id);assert.equal(f.counts().extensionsCount,0);assert.equal((await f.read()).terminal,true);
});
test('revoked original authority stops the service without purchasing an extension',async t=>{
 const f=await fixture(t);await f.enable();f.advance(200000);f.revoke();await f.api.reconcile(f.r.id);assert.equal(f.counts().extensionsCount,0);assert.equal((await f.store.read('infrastructure-resources',f.r.id)).value.terminal,true);
});
test('disabling maintenance while its quote is in flight prevents the reservation',async t=>{
 const f=await fixture(t);await f.enable();f.advance(200000);
 f.onQuote(async()=>{const r=await f.read();await f.api.maintain('owner','project',r.id,{policy:null,expectedRevision:r.revision});});
 await f.api.reconcile(f.r.id);assert.equal(f.counts().extensionsCount,0);assert.equal((await f.balance()).reserved,'100');assert.equal((await f.read()).maintenance,null);
});
test('maintenance deadline and original grant cap cannot be expanded through the resource',async t=>{
 const f=await fixture(t);await assert.rejects(f.enable({...f.policy,until:1000000000}));await assert.rejects(f.enable({...f.policy,maxTotalCost:'1001'}),{code:'maintenance_budget_invalid'});
 const resource={state:'running',desired:'running',terminal:false,manifest:{mode:'http'},leaseUntil:300000,maintenance:{...f.policy,until:330000,nextCheckAt:0}};assert.equal(maintenanceDue(resource,250000,3600).due,false);
});
test('late final bills count at settlement time, while older unknown reservations stay held',async t=>{
 const f=await fixture(t);f.advance(2*86400000);
 await f.store.transaction(async tx=>{await tx.write('infrastructure-controls','cpu',{dailyLimit:'150'},0);await tx.write('infrastructure-resources','late-bill',{profile:{id:'cpu'},createdAt:1,billing:'settled',actual:'50',settledAt:1_000_000+2*86400000,reservedMaximum:'100'},0);});
 await f.api.control.checkSpend(f.store,'cpu','0');await assert.rejects(f.api.control.checkSpend(f.store,'cpu','1'),{code:'infrastructure_daily_limit'});
});

test('fleet reports accessible resources only and retains pagination without contacting the provider',async t=>{
 const f=await fixture(t);f.identity.projects=async()=>({items:[{id:'project'},{id:'denied'}],nextCursor:'next-owned-project'});
 await f.store.transaction(tx=>tx.write('infrastructure-resources','foreign-secret',{projectId:'stranger',profile:{id:'cpu'},id:'foreign-secret'},0));
 const result=await f.api.fleet('owner',{});assert.equal(result.items.length,1);assert.equal(result.items[0].id,f.r.id);assert.equal(result.items[0].manifest,undefined);assert.equal(result.unavailable[0].projectId,'denied');assert.equal(result.nextProjectCursor,'next-owned-project');assert.equal(result.complete,false);assert.equal(f.counts().creates,1);
});
