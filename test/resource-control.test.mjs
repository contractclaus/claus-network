import test from 'node:test';import assert from 'node:assert/strict';
import {openStore} from '../src/storage/index.mjs';import {createBilling} from '../src/billing/index.mjs';import {createInfrastructure} from '../src/infrastructure/index.mjs';import {digest} from '../src/shared/index.mjs';
test('Claus allocates funded server credit without increasing parent limits; unknown costs remain reserved',async t=>{
 const store=openStore(':memory:');t.after(()=>store.close());const now=()=>1000000;
 const identity={credential:async a=>({kind:'owner',principalId:a}),authorize:async(a,action,{projectId})=>{assert.equal(a,'claus');assert.equal(projectId,'project');}};
 await store.transaction(async tx=>{await tx.write('network','authority',{ownerAddress:'0xowner'},0);await tx.write('principals','owner',{chainId:1,address:'0xowner'},0);await tx.write('principals','claus',{chainId:1,address:'0xclaus'},0);await tx.write('projects','project',{ownerId:'claus'},0);});
 await createBilling({store,authorize:async()=>true,now}).recordFunding({actor:'owner',account:'provider',asset:'USD',amount:'1000',receiptId:'isolated-fixture'});
 const api=createInfrastructure({store,identity,now,enabled:true});
 const profile={id:'cpu',enabled:true,provider:'fly',accountId:'provider',asset:'USD',fundingAccount:'provider',permissionHash:digest('real-authority'),maxLeaseSeconds:3600,maxPerLease:'100',maxActive:2,imagePrefixes:['example.com/claus/'],regions:['ams'],maxCpu:2,maxMemoryMiB:1024,maxStorageGiB:0,gpuTypes:[]};
 const policy={profile,operators:['claus'],enabled:true,expiresAt:null,totalLimit:'1000',perProjectLimit:'500',dailyLimit:'200',expectedRevision:0};
 await assert.rejects(api.control.configure('claus',policy),{code:'scope_denied'});await api.control.configure('owner',policy);
 const grant={profileId:'cpu',enabled:true,expiresAt:2000000,limit:'500',expectedRevision:0,idempotencyKey:'one',reason:'Run the existing project service.'};
 const first=await api.control.grant('claus','project',grant);assert.deepEqual(await api.control.grant('claus','project',grant),first);
 await assert.rejects(api.control.grant('claus','project',{...grant,expectedRevision:1,limit:'1001',idempotencyKey:'over'}),{code:'infrastructure_project_limit'});
 await store.transaction(async tx=>{await tx.write('infrastructure-resources','pending',{profile,createdAt:1,billing:'reserved',reservedMaximum:'150'},0);});
 await assert.rejects(api.control.checkSpend(store,'cpu','51'),{code:'infrastructure_daily_limit'});await api.control.checkSpend(store,'cpu','50');
 assert.equal((await api.control.policy('claus','cpu')).remaining,'500');
});

test('public resource grant route strips its path identity before strict domain validation',async()=>{
 const {createService}=await import('../interfaces/service.mjs');let seen;
 const service=createService({identity:{credential:async()=>({kind:'owner'})},infrastructure:{control:{grant:async(...args)=>{seen=args;return {ok:true}}}}});
 // Public route dispatch includes path parameters; domain input must not.
 await service.executeAs('resource_grant_set',{projectId:'project',profileId:'cpu',enabled:true,expiresAt:2000000,limit:'100',expectedRevision:0,idempotencyKey:'public',reason:'Run existing service.'},'owner');
 assert.equal(seen[1],'project');assert.equal(Object.hasOwn(seen[2],'projectId'),false);
});
