import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {uploadDataFile,downloadDataFile} from '../interfaces/data-files.mjs';
const sha=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
test('a lost upload response is reconciled through the original file rather than resent',async()=>{
 const bytes=new Uint8Array([1,2,3]),calls=[];let puts=0;
 const client={call:async(name,input)=>{calls.push(name);if(name==='data_file_prepare')return{file:{id:'original',sha256:sha(bytes),bytes:bytes.length,state:'uploading'},upload:{url:'https://acct.r2.cloudflarestorage.com/bucket/file',expiresAt:Date.now()+60000,headers:{'content-length':'3','content-type':'application/octet-stream','if-none-match':'*'}}};if(name==='data_file_commit')return{id:input.fileId,state:'ready'};throw Error('unexpected');}};
 const result=await uploadDataFile(client,{projectId:'project',name:'file',bytes,idempotencyKey:'original'},{fetch:async(_url,options)=>{puts++;assert(!Object.hasOwn(options.headers,'authorization'));throw Error('lost response')}});
 assert.equal(result.id,'original');assert.equal(puts,1);assert.deepEqual(calls,['data_file_prepare','data_file_commit']);
});
test('download verifies exact bytes and rejects a substituted object',async()=>{
 const bytes=new Uint8Array([1,2,3]),client={call:async()=>({file:{bytes:3,sha256:sha(bytes)},download:{url:'https://acct.r2.cloudflarestorage.com/bucket/file',expiresAt:Date.now()+60000}})};
 const result=await downloadDataFile(client,{projectId:'p',fileId:'f'},{fetch:async()=>new Response(bytes)});assert.deepEqual(result.bytes,bytes);
 await assert.rejects(downloadDataFile(client,{projectId:'p',fileId:'f'},{fetch:async()=>new Response(new Uint8Array([3,2,1]))}),/hash_mismatch/);
});
