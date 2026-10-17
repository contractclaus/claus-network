import test from 'node:test';
import assert from 'node:assert/strict';
import {createSignerApp} from '../src/index.js';
test('OCI route reaches its dedicated authentication without opening other operator routes',async()=>{
 const env={SERVICE_ROLE:'operator',CLAUS_OCI_RUNNER:'{}',CLAUS_OCI_NETWORK_SECRET:'s'.repeat(32)};
 const prior=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);
 try{
  const app=createSignerApp({database:()=>{throw Error('unexpected database access');}});
  const missing=await app.request('/api/oci-builds',{method:'POST',body:'{}'});assert.equal(missing.status,401);assert.equal((await missing.json()).error,'unauthorized');
  const authorized=await app.request('/api/oci-builds',{method:'POST',headers:{authorization:'Bearer '+env.CLAUS_OCI_NETWORK_SECRET},body:'x'.repeat(4097)});assert.equal(authorized.status,413);
  const unrelated=await app.request('/api/completion',{method:'POST',headers:{authorization:'Bearer '+env.CLAUS_OCI_NETWORK_SECRET},body:'{}'});assert.equal(unrelated.status,403);
 }finally{for(const [k,v]of Object.entries(prior)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});
