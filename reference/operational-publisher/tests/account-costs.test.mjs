import test from 'node:test';import assert from 'node:assert/strict';
import {accountCosts} from '../src/resources/account-costs.mjs';
const day=86400000,now=Date.parse('2026-10-18T06:00:00Z');
const row={ChargePeriodStart:'2026-10-16T07:00:00Z',ChargePeriodEnd:'2026-10-17T07:00:00Z',BillingCurrency:'USD',ServiceProviderName:'Vercel',ServiceName:'Build CPU Minutes',BilledCost:2,EffectiveCost:3,Tags:{ProjectId:'prj_one'}};
test('billing keeps credited costs, reporting gaps and team fees distinct; interrupted streams retain no observation',async()=>{
 const saved=[],env={RESOURCE_VERCEL_TOKEN:'test'},store={put:async(...args)=>saved.push(args)};
 const request=async url=>{assert.equal(new URL(url).searchParams.get('teamId'),'team_uolDmrwvORBaI3V7q4JVMKNS');return new Response([row,{...row,ServiceName:'Pro',BilledCost:1,EffectiveCost:1,Tags:{}}].map(v=>JSON.stringify(v)).join('\n'));};
 const costs=accountCosts({store,request,env,now:()=>now});
 const result=await costs({provider:'vercel'});assert.equal(result.totals.billed,3);assert.equal(result.totals.appliedCredits,1);assert.equal(result.unreportedInterval.from,'2026-10-17T07:00:00.000Z');assert.equal(result.projects.length,2);
 assert.equal((await costs({provider:'vercel',projectId:'prj_one'})).totals.billed,2);
 await assert.rejects(costs({provider:'vercel',from:new Date(now-32*day).toISOString()}));
 const bad=accountCosts({store,env,now:()=>now,request:async()=>new Response(JSON.stringify(row)+'\n{')});await assert.rejects(bad({provider:'vercel'}));assert.equal(saved.length,2);
});
