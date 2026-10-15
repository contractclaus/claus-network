import test from 'node:test';import assert from 'node:assert/strict';
import {openStore} from '../src/storage/index.mjs';import {createComputeControl} from '../src/inference/control.mjs';
import {createBilling} from '../src/billing/index.mjs';import {createInference} from '../src/inference/index.mjs';import {digest} from '../src/shared/index.mjs';
async function fixture(t){
 const store=openStore(':memory:');t.after(()=>store.close());const now=()=>1800000000000;
 const identity={credential:async a=>({kind:'owner',principalId:a})};
 const api=createComputeControl({store,identity,now});
 await store.transaction(async tx=>{await tx.write('network','authority',{ownerAddress:'owner'},0);for(const id of ['owner','claus','outsider'])await tx.write('principals',id,{address:id,chainId:1},0);for(const id of ['a','b'])await tx.write('projects',id,{ownerId:id},0);});
 await createBilling({store,authorize:()=>true,now}).recordFunding({actor:'owner',account:'funding',asset:'micro',amount:'1000',receiptId:'fixture'});
 const profile={id:'profile',version:'1',enabled:true,providerId:'surplus',accountId:'account',model:'model',providers:['openai'],asset:'micro',fundingAccount:'funding',permissionHash:digest({a:1}),dataPolicyHash:digest({d:1}),expiresAt:null,maximumPerRequest:'100',maxInputBytes:1000,maxOutputTokens:512};
 const config={profile,operators:['claus'],enabled:true,expiresAt:null,totalLimit:'1000',perProjectLimit:'800',expectedRevision:0};
 const grant=(key,limit='600')=>({profileId:'profile',enabled:true,expiresAt:now()+3600000,limit,expectedRevision:0,idempotencyKey:key,reason:'Complete a specified project milestone'});
 await api.configure('owner',config);return {store,identity,api,profile,config,grant,now};
}
test('concurrent grants cannot oversubscribe their shared funding; retries preserve the original grant',async t=>{
 const f=await fixture(t),r=await Promise.allSettled([f.api.grant('claus','a',f.grant('one')),f.api.grant('claus','b',f.grant('two'))]);
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal(r.find(x=>x.status==='rejected').reason.code,'compute_budget_exhausted');
 assert.deepEqual(await f.api.grant('claus','a',f.grant('one')),r[0].value);
 assert.equal((await f.api.policy('claus','profile')).allocated,'600');
});
test('claus cannot change the parent budget or grant access as an outsider; legacy setters cannot bypass managed accounting',async t=>{
 const f=await fixture(t);await assert.rejects(f.api.configure('claus',{...f.config,expectedRevision:1}),{code:'scope_denied'});
 await assert.rejects(f.api.grant('outsider','a',f.grant('bad')),{code:'scope_denied'});
 const legacy=createInference({store:f.store,identity:f.identity,now:f.now});
 await assert.rejects(legacy.setAllowance('owner','a',{...f.grant('x')}),{code:'compute_policy_managed'});
 await assert.rejects(legacy.setProfile('owner',{profile:f.profile,expectedRevision:1}),{code:'compute_policy_managed'});
});
test('revocation releases only unused allocation and retains unknown charges',async t=>{
 const f=await fixture(t);await f.api.grant('claus','a',f.grant('one'));
 const key=digest({projectId:'a',profileId:'profile'});await f.store.transaction(async tx=>{const old=await tx.read('inference-allowances',key);await tx.write('inference-allowances',key,{...old.value,reserved:'200',spent:'100'},old.revision);});
 await assert.rejects(f.api.grant('claus','a',{...f.grant('bad','0'),enabled:false,expectedRevision:2}),{code:'inference_allowance_below_exposure'});
 await f.api.grant('claus','a',{...f.grant('revoke','300'),enabled:false,expectedRevision:2});
 assert.equal((await f.api.policy('claus','profile')).allocated,'300');
 assert.equal((await f.store.read('inference-allowances',key)).value.reserved,'200');
});
test('new profiles cannot count the same funding twice and expired policies refuse new grants',async t=>{
 const f=await fixture(t);await assert.rejects(f.api.configure('owner',{...f.config,profile:{...f.profile,id:'second'}}),{code:'compute_funding_insufficient'});
 await f.api.configure('owner',{...f.config,enabled:false,expectedRevision:1});
 await assert.rejects(f.api.grant('claus','a',f.grant('one')),{code:'compute_policy_unavailable'});
 assert.equal(await f.api.active(f.store,'profile'),false);
});
