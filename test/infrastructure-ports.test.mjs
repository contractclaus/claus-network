import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {infrastructurePorts} from '../runtime/infrastructure-ports.mjs';
import {canonical,digest} from '../src/shared/index.mjs';

test('custody observations require the exact operation, input and signed result',async()=>{
 const secret='s'.repeat(32);let tamper=false;
 const {ports}=infrastructurePorts({env:{CRON_SECRET:secret},request:async(url,init)=>{
  assert.equal(url,'https://claus-inference.vercel.app/api/infrastructure');const {operation,input}=JSON.parse(init.body);
  const result={enabled:false,configured:false,profiles:[]},proof=createHmac('sha256',secret).update(canonical({operation,input,result})).digest('hex');
  return Response.json({result:{...result,enabled:tamper,proof}});
 }});
 assert.equal((await ports.readiness()).enabled,false);tamper=true;
 await assert.rejects(ports.readiness(),{code:'infrastructure_proof_invalid'});
});

test('only a receipt verified in the custody response can settle provider money',async()=>{
 const secret='s'.repeat(32),receipt={id:'a',resourceId:digest('w'),accountId:'p',asset:'USD',actual:'0',final:true};
 const {ports}=infrastructurePorts({env:{CRON_SECRET:secret},request:async(_url,init)=>{
  const {operation,input}=JSON.parse(init.body),result={operationId:input.id,receipt};
  return Response.json({result:{...result,proof:createHmac('sha256',secret).update(canonical({operation,input,result})).digest('hex')}});
 }});
 const w={id:digest('w'),projectId:'p',profile:{},manifest:{},quote:{},createdAt:1,leaseUntil:2};
 const r=await ports.inspect(w);assert.equal(await ports.verifyReceipt(w,r.receipt),true);
 assert.equal(await ports.verifyReceipt(w,structuredClone(r.receipt)),false);
});
