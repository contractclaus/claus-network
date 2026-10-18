import test from 'node:test';import assert from 'node:assert/strict';import {resourcesTool} from '../src/operations/resources.js';
test('continuation keeps its original identity on success and lost responses',async()=>{
 const original=globalThis.fetch;let received:any;
 try{globalThis.fetch=async(_url,options)=>{received=JSON.parse(String(options?.body));return new Response(JSON.stringify({result:{pending:true}}));};
 const result=await resourcesTool('new-call',{requestId:'original-call',operation:'deployment_stage',input:'{}'});assert.equal(received.requestId,'original-call');assert.equal(result.originalRequestId,'original-call');
 globalThis.fetch=async()=>{throw Error('timeout');};const lost=await resourcesTool('new-call',{requestId:'original-call',operation:'deployment_stage'});assert.equal(lost.originalRequestId,'original-call');assert.equal(lost.retry,false);
 }finally{globalThis.fetch=original;}
});
