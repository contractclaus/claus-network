import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createOciBroker,receiptFromZip} from '../src/github/oci.mjs';
const h=v=>'sha256:'+createHash('sha256').update(v).digest('hex');
function zip(value,name='receipt.json'){
 const content=Buffer.from(JSON.stringify(value)),n=Buffer.from(name),local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);
 local.writeUInt32LE(0x04034b50);local.writeUInt32LE(content.length,18);local.writeUInt32LE(content.length,22);local.writeUInt16LE(n.length,26);
 central.writeUInt32LE(0x02014b50);central.writeUInt32LE(content.length,20);central.writeUInt32LE(content.length,24);central.writeUInt16LE(n.length,28);
 end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+n.length,12);end.writeUInt32LE(local.length+n.length+content.length,16);
 return Buffer.concat([local,n,content,central,n,end]);
}
test('receipt ZIP cannot extract paths or oversized data',()=>{
 assert.deepEqual(receiptFromZip(zip({ok:true})),{ok:true});assert.throws(()=>receiptFromZip(zip({},'../receipt.json')));assert.throws(()=>receiptFromZip(Buffer.alloc(70000)));
});
test('lost workflow dispatch keeps one intent; original runner and completed receipt survive later configuration',async()=>{
 const sha='a'.repeat(40),c={enabled:true,sha,ref:'claus-oci-v1-test'},work={id:h('build'),projectId:'p',planId:h('plan'),sourceHash:h('source')};let state=null,dispatches=0,run=false;
 const ledger={get:async()=>state,reserve:async(_id,input)=>{if(state)return {created:false,row:state};state={status:'reserved'};return {created:true,row:state};},checkpoint:async(_id,v)=>state.result=structuredClone(v),complete:async(_id,v)=>{state.status='completed';state.result=structuredClone(v);}};
 const receipt={buildId:work.id,projectId:'p',planId:work.planId,sourceHash:work.sourceHash,imageDigest:h('image'),archiveHash:h('archive'),archiveBytes:100,runId:'42',runnerSha:sha,evidence:'compiled_only'};
 const archive=zip(receipt);
 const r={id:42,run_attempt:1,display_title:'Claus OCI '+work.id,head_sha:sha,event:'workflow_dispatch',status:'completed',conclusion:'success',repository:{full_name:'contractclaus/claus-network'},html_url:'https://github.com/contractclaus/claus-network/actions/runs/42'};
 const request=async(url,opts={})=>{
   url=String(url);
   if(url.endsWith('/dispatches')){dispatches++;run=true;throw Error('lost acknowledgement');}
   if(url.includes('/git/ref/tags/'))return Response.json({object:{sha,type:'commit'}});
   if(url.endsWith('/repos/contractclaus/claus-network'))return Response.json({private:false,owner:{login:'contractclaus'}});
   if(url.startsWith('https://claus-network-api'))return Response.json({buildId:work.id,plan:{id:work.planId,sourceHash:work.sourceHash,projectId:'p'}});
   if(url.includes('/workflows/')&&url.includes('/runs?'))return Response.json({workflow_runs:run?[r]:[]});
   if(url.endsWith('/actions/runs/42'))return Response.json(r);
   if(url.endsWith('/runs/42/artifacts?per_page=100'))return Response.json({artifacts:[{id:1,name:'oci-receipt',digest:h(archive),size_in_bytes:archive.length},{id:2,name:'oci-image',digest:h('image zip'),size_in_bytes:200,expires_at:'2026-10-18T00:00:00Z'}]});
   if(url.endsWith('/artifacts/1/zip'))return new Response(null,{status:302,headers:{location:'https://example.blob.core.windows.net/receipt.zip'}});
   if(url==='https://example.blob.core.windows.net/receipt.zip'){assert.equal(opts.headers,undefined);return new Response(archive);}
   throw Error('unexpected URL '+url);
 };
 const broker=createOciBroker({token:()=> 'test',secret:()=> 'test-secret',config:()=>c,request,ledger});
 assert.equal((await broker({operation:'dispatch',work})).state,'unknown');
 const result=await broker({operation:'inspect',work});assert.equal(result.state,'compiled');assert.equal(dispatches,1);assert.equal(result.receipt.imageDigest,receipt.imageDigest);
 c.sha='b'.repeat(40);c.ref='claus-oci-v2-test';c.enabled=false;
 assert.equal((await broker({operation:'inspect',work})).state,'compiled');assert.equal(dispatches,1);
});
