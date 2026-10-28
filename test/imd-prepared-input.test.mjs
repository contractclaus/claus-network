import test from 'node:test';import assert from 'node:assert/strict';import {preparedAuditInput} from '../adapters/imd.mjs';import {digest} from '../src/shared/index.mjs';
test('runtime quote accepts only the provider documented empty entry-list normalization',()=>{
 const request={template:'audit',repoUrl:'https://github.com/contractclaus/claus-network',baseCommit:'a'.repeat(40),github:false,objective:'Read the exact runtime source.'};
 const prepared={...request,contracts:[]};assert.equal(digest(preparedAuditInput(request)),digest(prepared));
 assert.notEqual(digest(preparedAuditInput(request)),digest({...prepared,baseCommit:'b'.repeat(40)}));
 const contract={...request,contracts:['src/Actual.sol']};assert.deepEqual(preparedAuditInput(contract),contract);
 assert.deepEqual(preparedAuditInput({template:'other'}),{template:'other'});
});

import {createImdReviewProvider} from '../adapters/imd.mjs';
import {createImdPayment} from '../adapters/imd-payment.mjs';
function provider(expiry,fetcher){return createImdReviewProvider({
 store:{read:async collection=>({value:collection==='imd-offer-index'?{id:'saved'}:{quote:{id:'offer',expiresAt:expiry},sealed:{}}})},
 sealer:{open:()=>({requestToken:'fixture'})},now:()=>1000000,fetch:fetcher
});}
test('expired and near-expiry quotes never dispatch a provider request',async()=>{
 for(const expiry of [999,1000,1059,1060]){let calls=0;
 await assert.rejects(provider(expiry,async()=>{calls++;throw Error('unexpected network');}).challenge('offer'),{code:'payment_window_expired'});
 assert.equal(calls,0);}
});
test('fresh provider rejections remain unknown instead of being reclassified as expiry',async()=>{
 let calls=0;await assert.rejects(provider(1061,async()=>{calls++;return new Response('',{status:503});}).challenge('offer'),{code:'provider_request_rejected',httpStatus:503});assert.equal(calls,1);
});
test('the retirement path refuses any payment with a submit intent',async()=>{
 const payment=createImdPayment({});
 for(const state of ['submitting','submitted','outcome_unknown','provider_paid']){
  let writes=0;assert.equal(await payment.abandonUnsent({read:async()=>({value:{state}}),write:async()=>writes++},'offer'),false);assert.equal(writes,0);
 }
 assert.equal(await payment.abandonUnsent({read:async()=>null},'offer'),true);
});
