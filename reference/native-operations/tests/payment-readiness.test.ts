import {test} from 'node:test';
import assert from 'node:assert/strict';
import {paymentReadiness,readPaymentReadiness,unsignedPaymentBlocker} from '../src/payment-readiness.ts';
const failed={id:'original:0',kind:'inference',status:'failed',result:{failure:'permit2_allowance_required',payment:'not_signed',requiredMicroUsdc:'649623'}};
test('original shortage is not hidden by ample cash; exact allowance recovers',()=>{
 assert.deepEqual(paymentReadiness({cashMicroUsdc:'1414481065',allowanceMicroUsdc:'560282'},'649623'),{state:'limited',ready:false,reason:'permit2_allowance_required',maximumMicroUsdc:'649623',cashMicroUsdc:'1414481065',allowanceMicroUsdc:'560282',authorityChanged:false});
 assert.equal(paymentReadiness({cashMicroUsdc:'1414481065',allowanceMicroUsdc:'649623'},'649623').ready,true);
 assert.equal(paymentReadiness({cashMicroUsdc:'1',allowanceMicroUsdc:'100000000'},'649623').reason,'payer_cash_insufficient');
});
test('wait preserves the original failure and does not execute a replacement',async()=>{
 const before=structuredClone(failed);let calls=0;
 const blocked=await unsignedPaymentBlocker(failed,async required=>{calls++;assert.equal(required,'649623');return paymentReadiness({cashMicroUsdc:'1414481065',allowanceMicroUsdc:'560282'},required) as any;});
 assert.equal(blocked?.originalRequestId,failed.id);assert.equal(calls,1);assert.deepEqual(failed,before);
 assert.equal(await unsignedPaymentBlocker(failed,async required=>paymentReadiness({cashMicroUsdc:'1414481065',allowanceMicroUsdc:'100000000'},required) as any),null);
});
test('unknown and completed requests are never reinterpreted as unsigned',async()=>{
 for(const action of [{...failed,status:'uncertain'},{...failed,status:'completed'},{...failed,result:{...failed.result,payment:'unresolved'}},{...failed,result:{...failed.result,failure:'different_failure'}}]){
  assert.equal(await unsignedPaymentBlocker(action,async()=>{throw Error('must_not_read_or_execute');}),null);
 }
});
test('read outage remains unknown; same-block reads return fixed allowance',async()=>{
 let calls=0;
 const result=await readPaymentReadiness('649623',()=>({getChainId:async()=>8453,getBlock:async()=>({number:42n,hash:'0x'+'a'.repeat(64)}),readContract:async p=>{calls++;assert.equal(p.blockNumber,42n);if(p.functionName==='allowance'){assert.equal(p.args[1],'0x000000000022d473030f116ddee9f6b43ac78ba3');return 560282n;}return 1414481065n;}}));
 assert.equal(calls,2);assert.equal(result.ready,false);assert.equal(result.reason,'permit2_allowance_required');
 const unavailable=await readPaymentReadiness('649623',()=>({getChainId:async()=>1}));assert.equal(unavailable.state,'unknown');
 const blocker=await unsignedPaymentBlocker(failed,async()=>unavailable);assert.equal(blocker?.reason,'payment_rail_unavailable');
});
