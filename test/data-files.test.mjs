import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {openStore} from '../src/storage/index.mjs';import {createDataFiles,DATA_LIMITS} from '../src/data-files/index.mjs';import {createR2Objects} from '../adapters/r2-objects.mjs';
const sha=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
async function fixture(t,limits=DATA_LIMITS){
 const store=openStore(':memory:');t.after(()=>store.close());let now=1000000,active=true,deletes=0,lostDelete=false;const saved=new Map();
 const key=(p,h)=>p+'/'+h;const objects={upload:async(p,h,{bytes,expiresIn})=>({url:'https://test.invalid/upload',namespace:p,sha256:h,bytes,expiresAt:now+expiresIn*1000,headers:{'content-length':String(bytes)}}),read:async(p,h)=>{const b=saved.get(key(p,h));return b?{state:'verified',bytes:b,length:b.length}:{state:'not_found'}},download:async()=>({url:'https://test.invalid/download',expiresAt:now+60000}),remove:async(p,h)=>{deletes++;saved.delete(key(p,h));if(lostDelete){lostDelete=false;throw Object.assign(Error('lost'),{code:'r2_delete_outcome_unknown'})}return{removed:true}}};
 objects.put=async(p,b)=>{const h=sha(b).slice(7);saved.set(key(p,h),Buffer.from(b));return{state:'verified',sha256:h,bytes:b.length}};
 const identity={authorize:async(a,_s,{projectId})=>{if(!active||a!=='owner'||projectId!=='project')throw Object.assign(Error('denied'),{code:'scope_denied'})}};
 const api=createDataFiles({store,identity,objects,limits,now:()=>now});
 const prepare=(bytes=Buffer.from('real data'),idempotencyKey='original')=>api.prepare('owner','project',{name:'data/history.json',bytes:bytes.length,sha256:sha(bytes),idempotencyKey});
 return{store,api,objects,saved,prepare,upload:(p,b)=>saved.set(key(p.upload.namespace,p.upload.sha256),b),advance:n=>now+=n,revoke:()=>active=false,lostDelete:()=>lostDelete=true,deletes:()=>deletes};
}
test('private uploads reserve once, verify bytes and keep the original ID across retries',async t=>{
 const f=await fixture(t),bytes=Buffer.from('real data'),p=await f.prepare(bytes);await f.prepare(bytes);
 assert.equal((await f.store.read('data-capacity','project')).value.bytes,bytes.length);f.upload(p,bytes);const file=await f.api.commit('owner','project',p.file.id);assert.equal(file.state,'ready');assert.equal((await f.api.commit('owner','project',p.file.id)).id,file.id);
 assert((await f.api.download('owner','project',file.id)).download.url);await assert.rejects(f.api.get('stranger','project',file.id),{code:'scope_denied'});await assert.rejects(f.api.get('owner','other',file.id),{code:'scope_denied'});
});
test('false checksums, changed requests and revoked credentials cannot commit a private file',async t=>{
 const f=await fixture(t),p=await f.prepare();f.upload(p,Buffer.from('different'));await assert.rejects(f.api.commit('owner','project',p.file.id),{code:'data_upload_integrity_failed'});await assert.rejects(f.prepare(Buffer.from('new data'),'original'),{code:'idempotency_conflict'});f.revoke();await assert.rejects(f.api.commit('owner','project',p.file.id),{code:'scope_denied'});
});
test('deletion waits out issued URLs and only then releases quota once',async t=>{
 const f=await fixture(t),bytes=Buffer.from('real data'),p=await f.prepare(bytes);f.upload(p,bytes);const file=await f.api.commit('owner','project',p.file.id);
 const removal=await f.api.remove('owner','project',file.id,{expectedRevision:file.revision});assert.equal(removal.waiting,true);await assert.rejects(f.api.download('owner','project',file.id),{code:'data_file_not_ready'});assert.equal((await f.store.read('data-capacity','project')).value.bytes,bytes.length);
 f.advance(65001);assert.equal((await f.api.clean()).removed,1);await f.api.clean();assert.equal((await f.store.read('data-capacity','project')).value.bytes,0);assert.equal(f.deletes(),1);
});
test('unknown deletion retains its capacity and retries the same object after backoff',async t=>{
 const f=await fixture(t),bytes=Buffer.from('real data'),p=await f.prepare(bytes);f.upload(p,bytes);const file=await f.api.commit('owner','project',p.file.id);await f.api.remove('owner','project',file.id,{expectedRevision:file.revision});f.advance(65001);f.lostDelete();await f.api.clean();assert.equal((await f.store.read('data-capacity','project')).value.bytes,bytes.length);assert.equal((await f.api.get('owner','project',file.id)).lastError,'r2_delete_outcome_unknown');f.advance(60001);assert.equal((await f.api.clean()).removed,1);assert.equal((await f.store.read('data-capacity','project')).value.bytes,0);
});
test('expired uncommitted uploads are cleaned without becoming visible files',async t=>{
 const f=await fixture(t),p=await f.prepare();f.advance(DATA_LIMITS.uploadMs+1);await f.api.clean();f.advance(5001);assert.equal((await f.api.clean()).removed,1);assert.equal((await f.api.get('owner','project',p.file.id)).state,'deleted');
});
test('concurrent upload requests cannot exceed the project reservation limit',async t=>{
 const f=await fixture(t,{...DATA_LIMITS,projectBytes:12});const r=await Promise.allSettled([f.prepare(Buffer.from('real data'),'one'),f.prepare(Buffer.from('other one'),'two')]);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal((await f.store.read('data-capacity','project')).value.bytes,9);
});
test('signed upload binds exact length, MIME and immutable object creation',async()=>{
 const objects=await createR2Objects({accountId:'a'.repeat(32),bucket:'claus-test',accessKeyId:'test-key',secretAccessKey:'test-secret',maxBytes:50,uploads:true});const upload=await objects.upload('project','b'.repeat(64),{bytes:9});const headers=new URL(upload.url).searchParams.get('X-Amz-SignedHeaders').split(';');for(const h of ['content-length','content-type','if-none-match'])assert(headers.includes(h));assert.equal(upload.headers['content-length'],'9');assert.equal(upload.headers['if-none-match'],'*');
});

test('small private text and binary files can be written and read through the API alone',async t=>{
 const f=await fixture(t);const file=await f.api.write('owner','project',{name:'notes/latest.json',content:'{"healthy":true}',idempotencyKey:'note'});assert.equal(file.state,'ready');const read=await f.api.read('owner','project',file.id);assert.equal(read.content,'{"healthy":true}');
 const bytes=Buffer.from([0,1,255,128]),binary=await f.api.write('owner','project',{name:'data/result.bin',content:bytes.toString('base64'),encoding:'base64',idempotencyKey:'binary'});assert.equal((await f.api.read('owner','project',binary.id,{encoding:'base64'})).content,bytes.toString('base64'));
 await assert.rejects(f.api.write('owner','project',{name:'data/bad.bin',content:'%%%invalid',encoding:'base64',idempotencyKey:'bad'}),{code:'data_content_invalid'});
});
test('HTTP and MCP expose actual private file writes and reads with the same permissions',async t=>{
 const f=await fixture(t);const {createApplication}=await import('../runtime/server.mjs'),{digest}=await import('../src/shared/index.mjs');const token='cln_'+'a'.repeat(43),other='cln_'+'b'.repeat(43),at=Date.now();
 await f.store.transaction(async tx=>{await tx.write('credentials',digest(token),{kind:'owner',principalId:'owner',expiresAt:at+3600000},0);await tx.write('credentials',digest(other),{kind:'owner',principalId:'stranger',expiresAt:at+3600000},0);await tx.write('projects','project',{id:'project',ownerId:'owner',name:'Private files'},0);});
 const app=createApplication({store:f.store,dataObjects:f.objects,now:()=>1000000,rateSalt:'fixture-only'.repeat(8)}),call=(path,method='GET',body,auth=token)=>app.fetch(new Request('https://claus.si'+path,{method,headers:{authorization:'Bearer '+auth,'content-type':'application/json',accept:'application/json, text/event-stream'},...(body?{body:JSON.stringify(body)}:{})}));
 const written=await call('/v1/projects/project/data-files/content','POST',{name:'notes.json',content:'{"saved":true}',idempotencyKey:'http-original'});assert.equal(written.status,200);const file=await written.json();assert.equal(file.state,'ready');
 const r=await call('/v1/projects/project/data-files/'+encodeURIComponent(file.id)+'/content');assert.equal(r.status,200);assert.equal((await r.json()).content,'{"saved":true}');assert.equal((await call('/v1/projects/project/data-files/'+encodeURIComponent(file.id)+'/content','GET',undefined,other)).status,403);
 const m=await call('/mcp','POST',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'data_file_read',arguments:{projectId:'project',fileId:file.id}}});assert.equal(m.status,200);assert.equal((await m.json()).result.structuredContent.content,'{"saved":true}');
});
test('concurrent verification reads one original object and does not duplicate work',async t=>{
 const f=await fixture(t),bytes=Buffer.from('real data'),p=await f.prepare(bytes);f.upload(p,bytes);const original=f.objects.read;let unblock,reads=0;
 f.objects.read=async(...args)=>{reads++;await new Promise(r=>{unblock=r});return original(...args)};
 const first=f.api.commit('owner','project',p.file.id);while(!unblock)await new Promise(setImmediate);
 await assert.rejects(f.api.commit('owner','project',p.file.id),{code:'data_verification_busy'});unblock();assert.equal((await first).state,'ready');assert.equal(reads,1);
});
