import test from 'node:test';import assert from 'node:assert/strict';
import {flyBilling,parseFlyPrice} from '../src/infrastructure/fly-billing.mjs';
const config={organization:'claus-network',organizationId:'org-id',app:'claus-project',regions:[{code:'ams',name:'Amsterdam',egressMicroUsdPerGb:20000}]};
test('live shape pricing includes additional RAM, region and transfer without treating card billing as cash',async()=>{
 const html='<option value="1.1">Amsterdam</option><td>shared-cpu-2x · 512MB</td><td data-region-price="0.0061"></td><span data-region-price="6.003072">$6.00</span> per GB per month';
 const p=parseFlyPrice(html,{cpu:2,memoryMiB:4096,region:'ams',egressBudgetMiB:2048},config);
 assert(BigInt(p.hourlyMicroUsd)>38000n);assert(BigInt(p.extraMaximumMicroUsd)>40000n);assert.equal(p.networkBudget.bytes,2147483648);
 assert.throws(()=>parseFlyPrice(html,{cpu:3,memoryMiB:4096,region:'ams'},config),/shape_unavailable/);
 const b=flyBilling({token:()=> 'FlyV1 fixture',request:async(_url,init)=>{assert.equal(init.headers.authorization,'FlyV1 fixture');return Response.json({data:{organizations:{nodes:[{id:'org-id',slug:'claus-network',billable:true,billingStatus:'CURRENT',isCreditCardSaved:true}]}}});}});
 assert.equal((await b.account(config)).providerDeposit,false);
});
test('transfer counters survive restart and unavailable or stale measurements cannot authorize continued operation',async()=>{
 let at=200000,bytes=100,time=200;
 const b=flyBilling({token:()=> 'FlyV1 fixture',now:()=>at,request:async()=>Response.json({status:'success',isPartial:false,data:{resultType:'vector',result:[{value:[time,String(bytes)]}]}})});
 const c={createdAt:100000,providerResourceId:'abcd',price:{networkBudget:{bytes:1000}},traffic:{counterBytes:900,totalBytes:900}};
 const u=await b.usage({extensions:[]},c,config);assert.equal(u.totalBytes,1000);assert.equal(u.state,'limit-reached');
 const renewed=await b.usage({extensions:[{sequence:1}]},c,config);assert.equal(renewed.state,'within-budget');
 time=1;await assert.rejects(b.usage({extensions:[]},c,config),/metrics_stale/);
});
