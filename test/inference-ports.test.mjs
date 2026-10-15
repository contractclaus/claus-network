import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {inferencePorts} from '../runtime/inference-ports.mjs';import {copy,digest} from '../src/shared/index.mjs';
test('payer integration preserves one ID, binds its payload and accepts only final recorded costs',async()=>{
 const calls=[],model='gpt-6-sol',secret='secret'.repeat(8),time=1800000000000;let requestHash,final=false;
 const profile={providerId:'surplus',accountId:'claus-network-x402-v1',model,providers:['openai'],asset:'base-usdc-micro',maximumPerRequest:'2000000',maxOutputTokens:512,expiresAt:time+86400000};
 const ports=inferencePorts({env:{CLAUS_COMPUTE_SECRET:secret,CLAUS_COMPUTE_MODEL:model,CLAUS_COMPUTE_ENABLED:'1'},now:()=>time,fetcher:async(url,o)=>{
  calls.push({url,method:o.method});assert.equal(o.headers.authorization,'Bearer '+secret);
  if(o.method==='POST'){requestHash=createHash('sha256').update('2000000\n'+o.body).digest('hex');return Response.json({});}
  return Response.json({id:'network-compute:'+'a'.repeat(64),requestHash,status:'completed',response:{model,choices:[{finish_reason:'stop',message:{content:'useful result'}}]},accounting:final?{amount:'25',maximum:'200',final:true,proofHash:digest({actual:25})}:null});
 }});
 const request={model,input:'work',maxOutputTokens:512};const quote=await ports.provider.quote({profile,requestHash:digest(request)});
 assert(await ports.verifyQuote(copy(quote),copy(profile)));assert.equal(await ports.verifyQuote({...quote,maximum:'3000000'},profile),false);
 const payload={requestId:'a'.repeat(64),effectKey:'effect',requestHash:digest(request),profile,request,quote};
 const first=await ports.provider.dispatch(payload);assert.equal(first.work,'completed');assert.equal(first.receipt,undefined);
 final=true;const second=await ports.provider.reconcile(payload);assert.equal(second.receipt.actual,'25');assert.equal(calls.filter(c=>c.method==='POST').length,1);
 assert(await ports.verifyReceipt(second.receipt,{...payload,id:payload.requestId,loadRequest:async()=>request}));
 await assert.rejects(ports.provider.reconcile({...payload,request:{...request,input:'changed'}}),{code:'compute_receipt_binding_mismatch'});
});
