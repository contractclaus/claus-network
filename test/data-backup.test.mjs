import test from 'node:test';import assert from 'node:assert/strict';import {createHash,generateKeyPairSync} from 'node:crypto';
import {mkdtemp,writeFile,mkdir,symlink,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {digest} from '../src/shared/index.mjs';import {openStore} from '../src/storage/index.mjs';import {createProjectArchives,archiveKeyId,verifyProjectArchive} from '../src/portability/index.mjs';
import {exportDataBackup,restoreDataBackup,verifyDataBackup} from '../interfaces/data-backup.mjs';
const hash=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
function fixture(){
 const bytes=Buffer.from([0,1,255,128]),original={id:digest('original'),projectId:'source',name:'history/data.bin',sha256:hash(bytes),bytes:bytes.length,state:'ready',revision:3};
 const pending={...original,id:digest('pending'),state:'uploading'},target=new Map(),objects=new Map([[original.sha256,bytes]]),calls=[];let corrupt=false,changed=false,lost=false,pageSize=1;
 const client={async call(name,input){calls.push({name,input});const isTarget=input.projectId==='target';
  if(name==='data_file_list'){let list=isTarget?[...target.values()]:[original,pending];if(!isTarget&&changed&&calls.filter(c=>c.name===name&&c.input.projectId==='source').length>2)list=list.map(x=>({...x,revision:x.revision+1}));const start=input.after?list.findIndex(x=>x.id===input.after)+1:0,items=list.slice(start,start+pageSize);return{items,nextCursor:start+pageSize<list.length?items.at(-1).id:null,usage:{bytes:[...target.values()].reduce((s,x)=>s+x.bytes,0),count:target.size},limits:{bytes:104857600,files:1000}};}
  if(name==='resource_instances')return{items:[{id:digest('server'),projectId:'source',state:'running',providerResourceId:'original-server'}],nextCursor:null};
  if(name==='data_file_download')return{file:original,download:{url:'https://account.r2.cloudflarestorage.com/data',expiresAt:Date.now()+60000}};
  if(name==='data_file_prepare'){const id=digest({projectId:input.projectId,upload:input.idempotencyKey});let file=target.get(id);if(!file){file={id,projectId:input.projectId,name:input.name,sha256:input.sha256,bytes:input.bytes,state:'uploading',revision:1};target.set(id,file);}return{file,upload:file.state==='ready'?null:{url:'https://account.r2.cloudflarestorage.com/'+id.slice(7),expiresAt:Date.now()+60000,headers:{'content-length':String(input.bytes),'content-type':'application/octet-stream','if-none-match':'*'}}};}
  if(name==='data_file_commit'){const file=target.get(input.fileId);if(lost){lost=false;file.state='ready';throw Error('lost_receipt');}file.state='ready';return file;}
  throw Error('unexpected_operation:'+name);
 }};
 const request=async(_url,options)=>{if(options.method==='PUT')return new Response(null,{status:200});return new Response(corrupt?Buffer.from('bad'):bytes);};
 return{bytes,original,pending,target,objects,calls,client,request,corrupt:()=>corrupt=true,changed:()=>changed=true,lost:()=>lost=true,page:n=>pageSize=n};
}
async function backup(f){return exportDataBackup(f.client,{projectId:'source',fetch:f.request,writeBlob:async(h,b)=>f.objects.set(h,b)});}
test('private backup follows all pages, verifies binary content and keeps original pending/server identities',async()=>{
 const f=fixture(),b=await backup(f);assert.equal(verifyDataBackup(b).contentBytes,4);assert.equal(b.manifest.files.length,2);assert.equal(b.manifest.resources[0].providerResourceId,'original-server');assert.equal(b.manifest.resourceAuthority,'historical-only');assert(f.calls.filter(x=>x.name==='data_file_list').length===4);assert(!f.calls.some(x=>/request|pay|stop/.test(x.name)));
});
test('changing source never produces a successful backup manifest',async()=>{const f=fixture();f.changed();await assert.rejects(backup(f),/backup_source_changed/);});
test('corrupt downloads fail before a complete backup can be recorded',async()=>{const f=fixture();f.corrupt();await assert.rejects(backup(f),/data_download_(size|hash)_mismatch/);});
test('all backup blobs are checked before any restore mutation',async()=>{const f=fixture(),b=await backup(f);await assert.rejects(restoreDataBackup(f.client,{projectId:'target',backup:b,fetch:f.request,readBlob:async()=>Buffer.from('wrong')}),/backup_blob_corrupt/);assert.equal(f.target.size,0);});
test('restores reuse deterministic original restore IDs and never restart servers or payments',async()=>{
 const f=fixture(),b=await backup(f),readBlob=async h=>f.objects.get(h);const one=await restoreDataBackup(f.client,{projectId:'target',backup:b,fetch:f.request,readBlob}),two=await restoreDataBackup(f.client,{projectId:'target',backup:b,fetch:f.request,readBlob});assert.deepEqual(one,two);assert.equal(f.target.size,1);assert.equal(one.pendingFilesSkipped,1);assert.equal(one.resourcesRestored,false);assert.equal(one.financialActions,false);assert.equal(f.calls.filter(x=>x.name==='data_file_prepare').length,1);
});
test('lost restore acknowledgement is reconciled with the same ID instead of creating another file',async()=>{
 const f=fixture(),b=await backup(f),readBlob=async h=>f.objects.get(h);f.lost();await assert.rejects(restoreDataBackup(f.client,{projectId:'target',backup:b,fetch:f.request,readBlob}),/lost_receipt/);const restored=await restoreDataBackup(f.client,{projectId:'target',backup:b,fetch:f.request,readBlob});assert.equal(f.target.size,1);assert.equal(restored.restored.length,1);assert.equal(f.calls.filter(x=>x.name==='data_file_prepare').length,1);
});
test('manifest corruption is rejected before destination access',async()=>{const f=fixture(),b=await backup(f);b.manifest.files[0].name='other';const before=f.calls.length;await assert.rejects(restoreDataBackup(f.client,{projectId:'target',backup:b,readBlob:async h=>f.objects.get(h)}),/backup_manifest_corrupt/);assert.equal(f.calls.length,before);});
test('deleted history does not consume the active-file backup bound',async()=>{
 const f=fixture(),base=f.client.call.bind(f.client);f.client.call=async(name,input)=>{if(name==='data_file_list'&&input.projectId==='source'&&!input.after)return{items:Array.from({length:100},(_,i)=>({...f.original,id:digest('deleted'+i),state:'deleted'})),nextCursor:'old',usage:{bytes:4,count:1},limits:{bytes:104857600,files:1000}};if(name==='data_file_list'&&input.projectId==='source'&&input.after==='old')return{items:[f.original],nextCursor:null,usage:{bytes:4,count:1},limits:{bytes:104857600,files:1000}};return base(name,input);};
 const b=await backup(f);assert.equal(b.manifest.files.length,1);assert.equal(b.manifest.files[0].id,f.original.id);
});
test('restore refuses insufficient destination capacity before uploading anything',async()=>{
 const f=fixture(),b=await backup(f),base=f.client.call.bind(f.client);f.client.call=async(name,input)=>{const r=await base(name,input);if(name==='data_file_list'&&input.projectId==='target')r.limits.bytes=3;return r;};
 await assert.rejects(restoreDataBackup(f.client,{projectId:'target',backup:b,fetch:f.request,readBlob:async h=>f.objects.get(h)}),/restore_capacity_exceeded/);assert.equal(f.target.size,0);
});
test('signed historical exports include new private/runtime state without granting live authority',async t=>{
 const store=openStore(':memory:');t.after(()=>store.close());const projectId='p',address='0x'+'1'.repeat(40),{privateKey,publicKey}=generateKeyPairSync('ed25519');
 await store.transaction(async tx=>{
  await tx.write('projects',projectId,{id:projectId,ownerId:'owner'},0);await tx.write('principals','owner',{address,chainId:1},0);
  await tx.write('data-files','file',{id:'file',projectId,name:'binary.dat',sha256:hash(Buffer.from('x')),bytes:1,state:'uploading',secret:'must-not-export',actor:'must-not-export'},0);
  await tx.write('infrastructure-resources','server',{id:'server',projectId,state:'unknown',billing:'reserved',operationId:'original-operation',providerResourceId:'actual-provider',profile:{fundingAccount:'must-not-export'},actor:'must-not-export',controllerLease:{token:'must-not-export'}},0);
  await tx.write('data-files','other',{id:'other',projectId:'another',secret:'must-not-export'},0);
 });
 const archives=createProjectArchives({store,identity:{authorize:async()=>{}},operatorId:'https://source.test',signingKey:privateKey});
 const archive=await archives.export('owner',projectId),record=verifyProjectArchive(archive,{trustedOperators:{'https://source.test':{[archiveKeyId(publicKey)]:publicKey}},expectedOwner:{address,chainId:1}});
 assert.equal(record.authority,'historical-only');assert(record.records.some(r=>r.collection==='data-files'));assert(!JSON.stringify(archive).includes('must-not-export'));assert(!record.records.some(r=>r.id==='other'));
 assert(archive.manifest.pendingEffects.some(e=>e.kind==='infrastructure-resource'&&e.effectKey==='original-operation'));assert(archive.manifest.pendingEffects.some(e=>e.kind==='private-data-lifecycle'));
});
test('offline CLI validates a real directory and rejects symlinked data',async t=>{
 const f=fixture(),b=await backup(f),root=await mkdtemp(path.join(os.tmpdir(),'claus-data-test-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(root,'blobs'));await writeFile(path.join(root,'manifest.json'),JSON.stringify(b));const blob=path.join(root,'blobs',f.original.sha256.slice(7));await writeFile(blob,f.bytes);
 const script=new URL('../interfaces/data-cli.mjs',import.meta.url).pathname,exec=promisify(execFile);const r=await exec(process.execPath,[script,'inspect',root]);assert.equal(JSON.parse(r.stdout).valid,true);await rm(blob);await symlink(path.join(root,'manifest.json'),blob);await assert.rejects(exec(process.execPath,[script,'inspect',root]));
});
