import test from 'node:test';import assert from 'node:assert/strict';
import {runpodDriver} from '../src/infrastructure/providers.mjs';
import {createInfrastructureBroker} from '../src/infrastructure/broker.mjs';
test('Runpod funding reads fixed authenticated history and projects only completed exact-cent reloads',async()=>{
 let entry={id:'payment',amount:100,transactionCompletedAt:new Date(2000).toISOString(),medium:'STRIPE',type:'RELOAD'};
 const driver=runpodDriver({token:()=> 'private-test-key',now:()=>3000,request:async(url,init)=>{
  assert.equal(url,'https://api.runpod.io/graphql');assert.equal(init.headers.authorization,'Bearer private-test-key');
  assert(!JSON.stringify(JSON.parse(init.body)).includes('private-test-key'));
  return Response.json({data:{myself:{id:'account',clientBalance:148.1234567,stripeReloadHistory:[entry]}}});
 }});
 const r=await driver.fundingHistory({from:1000,to:3000});assert.equal(r.receipts[0].amount,'100000000');assert.equal(r.balanceMicroUsd,'148123456');
 entry={...entry,amount:0.000001};await assert.rejects(driver.fundingHistory({from:1000,to:3000}),/funding_amount_invalid/);
 entry={...entry,amount:100,transactionCompletedAt:null};await assert.rejects(driver.fundingHistory({from:1000,to:3000}),/funding_receipt_invalid/);
 entry={...entry,transactionCompletedAt:new Date(2000).toISOString(),type:'DEBIT'};await assert.rejects(driver.fundingHistory({from:1000,to:3000}),/funding_event_requires_review/);
});
test('funding history requires the existing enabled Runpod profile and is signed by custody',async()=>{
 const config={enabled:true,profiles:[{id:'cpu',enabled:true,provider:'runpod',accountId:'runpod'}]};let calls=0;
 const broker=createInfrastructureBroker({ledger:{},config:()=>config,secret:()=> 'x'.repeat(32),drivers:{runpod:{fundingHistory:async()=>{calls++;return{receipts:[]};}}}});
 await assert.rejects(broker.call({operation:'funding_history',input:{profileId:'foreign'}}),/funding_profile_unavailable/);assert.equal(calls,0);
 const r=await broker.call({operation:'funding_history',input:{profileId:'cpu'}});assert.equal(r.accountId,'runpod');assert.match(r.proof,/^[a-f0-9]{64}$/);
});
