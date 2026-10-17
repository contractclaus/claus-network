import {createHash,randomUUID} from 'node:crypto';
import {digest,integer,requireThat,sourcePath,text,contentHash,copy} from '../shared/index.mjs';
export const DATA_LIMITS=Object.freeze({fileBytes:50*1024*1024,projectBytes:100*1024*1024,globalBytes:1024*1024*1024,projectFiles:1000,uploadMs:15*60*1000,urlMs:60000});
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const namespace=r=>'data-'+digest({projectId:r.projectId,id:r.id}).slice(7);
const view=r=>{const {id,projectId,name,sha256,bytes,state,createdAt,uploadDeadline,verifiedAt,deletedAt,deleteAfter}=r.value;return {id,projectId,name,sha256,bytes,state,createdAt,uploadDeadline,verifiedAt:verifiedAt??null,deletedAt:deletedAt??null,deleteAfter:deleteAfter??null,revision:r.revision,lastError:r.value.cleanupError??null,nextCleanupAt:r.value.nextCleanupAt??null};};
export function createDataFiles({store,identity,objects,now=()=>Date.now(),limits=DATA_LIMITS}){
 const auth=(actor,projectId,write=false,reader=store)=>identity.authorize(actor,write?'artifact.write':'artifact.read',{projectId},reader);
 const load=async(reader,projectId,id)=>{contentHash(id);const row=await reader.read('data-files',id);requireThat(row?.value.projectId===projectId,'not_found');return row;};
 const available=()=>requireThat(objects,'data_storage_unavailable');
 async function capacity(tx,projectId,bytes,count){
  for(const [id,maxBytes,maxCount]of [[projectId,limits.projectBytes,limits.projectFiles],['global',limits.globalBytes,100000]]){
   const old=await tx.read('data-capacity',id),v=old?.value??{bytes:0,count:0};
   requireThat(v.bytes+bytes>=0&&v.count+count>=0,'data_capacity_corrupt');
   requireThat(v.bytes+bytes<=maxBytes&&v.count+count<=maxCount,'data_capacity_reached');
   await tx.write('data-capacity',id,{bytes:v.bytes+bytes,count:v.count+count},old?.revision??0);
  }
 }
 async function cleanup(id){
  const before=await store.read('data-files',id);if(!before)return {removed:false};const v=before.value;
  if(v.state==='deleted')return {removed:true};
  if(v.state==='uploading'&&v.uploadDeadline<=now())await store.transaction(async tx=>{const r=await load(tx,v.projectId,id);if(r.value.state==='uploading'&&r.value.uploadDeadline<=now())await tx.write('data-files',id,{...r.value,state:'deleting',deleteAfter:Math.max(now(),r.value.lastUrlExpiresAt??0)+5000},r.revision);});
  const row=await load(store,v.projectId,id);
  if(row.value.state!=='deleting'||row.value.deleteAfter>now())return {removed:false,waiting:true};
  available();const result=await objects.remove(namespace(v),v.sha256.slice(7));requireThat(result.removed===true,'data_delete_unconfirmed');
  await store.transaction(async tx=>{const r=await load(tx,v.projectId,id);if(r.value.state==='deleted')return;requireThat(r.value.state==='deleting'&&r.value.deleteAfter<=now(),'data_delete_state_changed');
   await capacity(tx,v.projectId,-v.bytes,-1);await tx.write('data-files',id,{...r.value,state:'deleted',deletedAt:now()},r.revision);
  });return {removed:true};
 }
 const api={
  discovery:()=>({enabled:!!objects,private:true,limits,uploads:'short-lived-signed-PUT',publication:false,backup:{profile:'claus-private-data-backup/1',client:'claus-data',resourceAuthority:'historical-only',restore:'verified-ready-files-only'},scope:{read:'artifact.read',write:'artifact.write'},immutable:true}),
  async prepare(actor,projectId,{name,sha256,bytes,idempotencyKey}){
   available();await auth(actor,projectId,true);sourcePath(name);contentHash(sha256);text(idempotencyKey);integer(bytes,1,limits.fileBytes);
   const id=digest({projectId,upload:idempotencyKey}),requestHash=digest({name,sha256,bytes});
   const saved=await store.transaction(async tx=>{await auth(actor,projectId,true,tx);const old=await tx.read('data-files',id);if(old){requireThat(old.value.requestHash===requestHash,'idempotency_conflict');return old;}
    await capacity(tx,projectId,bytes,1);return tx.write('data-files',id,{id,projectId,name,sha256,bytes,requestHash,state:'uploading',createdAt:now(),uploadDeadline:now()+limits.uploadMs,lastUrlExpiresAt:0},0);
   });
   if(saved.value.state==='ready')return {file:view(saved),upload:null};
   requireThat(saved.value.state==='uploading'&&saved.value.uploadDeadline>now(),'data_upload_expired');
   const upload=await objects.upload(namespace(saved.value),sha256.slice(7),{bytes,expiresIn:Math.min(60,Math.floor((saved.value.uploadDeadline-now())/1000))});
   requireThat(upload.expiresAt>now()&&upload.expiresAt<=now()+limits.urlMs+1000,'data_upload_invalid');
   const row=await store.transaction(async tx=>{await auth(actor,projectId,true,tx);const r=await load(tx,projectId,id);requireThat(r.value.state==='uploading'&&r.value.uploadDeadline>now(),'data_upload_state_changed');return tx.write('data-files',id,{...r.value,lastUrlExpiresAt:Math.max(r.value.lastUrlExpiresAt,upload.expiresAt)},r.revision);});
   return {file:view(row),upload};
  },
  async commit(actor,projectId,id){
   available();const lease=randomUUID();
   const r=await store.transaction(async tx=>{await auth(actor,projectId,true,tx);const row=await load(tx,projectId,id);if(row.value.state==='ready')return row;
    requireThat(row.value.state==='uploading'&&row.value.uploadDeadline>now(),'data_upload_expired');requireThat(!row.value.verification||row.value.verification.until<=now(),'data_verification_busy');
    return tx.write('data-files',id,{...row.value,verification:{id:lease,until:now()+60000}},row.revision);
   });
   if(r.value.state==='ready')return view(r);
   try{
    const value=await objects.read(namespace(r.value),r.value.sha256.slice(7));requireThat(value.state==='verified','data_upload_not_found');requireThat(value.length===r.value.bytes&&hash(value.bytes)===r.value.sha256,'data_upload_integrity_failed');
    return await store.transaction(async tx=>{await auth(actor,projectId,true,tx);const current=await load(tx,projectId,id);if(current.value.state==='ready')return view(current);requireThat(current.value.state==='uploading'&&current.value.uploadDeadline>now()&&current.value.verification?.id===lease,'data_upload_state_changed');return view(await tx.write('data-files',id,{...current.value,state:'ready',verification:null,verifiedAt:now()},current.revision));});
   }finally{await store.transaction(async tx=>{const current=await load(tx,projectId,id);if(current.value.verification?.id===lease)await tx.write('data-files',id,{...current.value,verification:null},current.revision);}).catch(()=>{});}
  },
  async write(actor,projectId,{name,encoding='utf8',content,idempotencyKey}){
   requireThat(typeof content==='string'&&content.isWellFormed()&&['utf8','base64'].includes(encoding),'data_content_invalid');
   const bytes=Buffer.from(content,encoding==='base64'?'base64':'utf8');requireThat(bytes.length>0&&bytes.length<=196608,'data_inline_size_invalid');
   if(encoding==='base64')requireThat(bytes.toString('base64')===content,'data_content_invalid');
   const prepared=await api.prepare(actor,projectId,{name,sha256:hash(bytes),bytes:bytes.length,idempotencyKey});
   if(prepared.file.state==='ready')return prepared.file;
   const stored=await objects.put(namespace(prepared.file),bytes);requireThat(stored.state==='verified','data_write_unknown');
   return api.commit(actor,projectId,prepared.file.id);
  },
  async read(actor,projectId,id,{encoding='utf8'}={}){
   available();await auth(actor,projectId);requireThat(['utf8','base64'].includes(encoding),'data_content_invalid');const r=await load(store,projectId,id);requireThat(r.value.state==='ready','data_file_not_ready');requireThat(r.value.bytes<=196608,'data_inline_read_too_large');
   const value=await objects.read(namespace(r.value),r.value.sha256.slice(7));requireThat(value.state==='verified'&&value.length===r.value.bytes&&hash(value.bytes)===r.value.sha256,'data_storage_integrity_failed');
   let content;try{content=encoding==='base64'?value.bytes.toString('base64'):new TextDecoder('utf-8',{fatal:true}).decode(value.bytes);}catch{requireThat(false,'data_not_utf8');}await auth(actor,projectId);requireThat((await load(store,projectId,id)).value.state==='ready','data_file_not_ready');return {file:view(r),encoding,content};
  },
  async get(actor,projectId,id){await auth(actor,projectId);return view(await load(store,projectId,id));},
  async list(actor,projectId,{after='',limit=50}={}){await auth(actor,projectId);integer(limit,1,100);const rows=await store.list('data-files',{projectId,after,limit});const usage=(await store.read('data-capacity',projectId))?.value??{bytes:0,count:0};return {items:rows.map(view),nextCursor:rows.length===limit?rows.at(-1).id:null,usage,limits:{bytes:limits.projectBytes,files:limits.projectFiles,fileBytes:limits.fileBytes}};},
  async download(actor,projectId,id){available();await auth(actor,projectId);const r=await load(store,projectId,id);requireThat(r.value.state==='ready','data_file_not_ready');const result=await objects.download(namespace(r.value),r.value.sha256.slice(7),{filename:r.value.sha256.slice(7),contentType:'application/octet-stream',expiresIn:60});
   const current=await load(store,projectId,id);requireThat(current.value.state==='ready','data_file_not_ready');await auth(actor,projectId);return {file:view(current),download:result};},
  async remove(actor,projectId,id,{expectedRevision}){available();integer(expectedRevision);await store.transaction(async tx=>{await auth(actor,projectId,true,tx);const r=await load(tx,projectId,id);if(['deleted','deleting'].includes(r.value.state))return;requireThat(r.revision===expectedRevision,'revision_conflict');await tx.write('data-files',id,{...r.value,state:'deleting',deleteAfter:Math.max(now()+limits.urlMs,r.value.lastUrlExpiresAt??0)+5000},r.revision);});const result=await cleanup(id);return {file:view(await load(store,projectId,id)),...result};},
  async clean(){if(!objects)return {enabled:false,removed:0};const rows=await store.pendingDataFiles({at:now(),limit:4});let removed=0;for(const r of rows)try{if((await cleanup(r.id)).removed)removed++;}catch(e){await store.transaction(async tx=>{const current=await tx.read('data-files',r.id);if(!current||current.value.state==='deleted')return;const failures=(current.value.cleanupFailures??0)+1;await tx.write('data-files',r.id,{...current.value,cleanupFailures:failures,cleanupError:typeof e.code==='string'?e.code:'data_cleanup_unavailable',nextCleanupAt:now()+Math.min(1800000,60000*2**Math.min(failures-1,5))},current.revision);}).catch(()=>{});}return {enabled:true,processed:rows.length,removed};}
 };
 return api;
}
