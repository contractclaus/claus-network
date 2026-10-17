import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '../interfaces/sdk.mjs';

test('uncertain mutations retain their original outcome without automatic replay',async()=>{
 for(const [status,body,outcome] of [
  [409,{error:'effect_requires_reconciliation',category:'unknown_outcome'},'unknown'],
  [409,{error:'effect_requires_reconciliation'},'unknown'],
  [409,{error:'provider_pending',outcome:'unknown'},'unknown'],
  [503,{error:'service_unavailable',outcome:'rejected'},'unknown'],
  [409,{error:'revision_conflict',category:'state'},'rejected'],
  [403,{error:'scope_denied'},'rejected'],
  [429,{error:'rate_limited',retryAfterSeconds:7},'rejected'],
 ]){
  let calls=0;
  const client=createClient({fetch:async()=>{calls++;return Response.json(body,{status});}});
  await assert.rejects(client.call('project_create',{name:'local fixture'}),e=>{
   assert.equal(e.outcome,outcome);assert.equal(e.status,status);assert.equal(e.details.automaticRetry,false);
   assert.equal(e.code,body.error);if(status===429)assert.equal(e.retryAfterSeconds,7);return true;
  });
  assert.equal(calls,1);
 }
});

test('uncertain read errors remain failed reads, not attempted mutations',async()=>{
 const client=createClient({fetch:async()=>Response.json({error:'effect_requires_reconciliation',category:'unknown_outcome'},{status:409})});
 await assert.rejects(client.call('capabilities'),e=>e.outcome==='read_failed'&&e.details.automaticRetry===false);
});
