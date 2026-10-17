import {canonical,digest} from '../src/shared/index.mjs';
import {downloadDataFile,uploadDataFile} from './data-files.mjs';

const SCHEMA='claus-private-data-backup/1',MAX_FILES=1000,MAX_FILE=50*1024*1024,MAX_BYTES=100*1024*1024;
const check=(ok,code)=>{if(!ok)throw Error(code);};
const hex=v=>typeof v==='string'&&/^sha256:[a-f0-9]{64}$/.test(v);
const contentHash=bytes=>digestBytes(bytes);
import {createHash} from 'node:crypto';
const digestBytes=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const fields=['id','projectId','name','sha256','bytes','state','revision'];
const description=file=>Object.fromEntries(fields.map(k=>[k,file[k]]));
const nameOk=name=>typeof name==='string'&&name.length<=180&&/^[a-zA-Z0-9_.@+/-]+$/.test(name)&&name.split('/').every(x=>x&&x!=='.'&&x!=='..');
async function inventory(client,operation,projectId,{signal}={}){
 const items=[],ids=new Set(),cursors=new Set();let after='',last;
 do{
  signal?.throwIfAborted();const page=await client.call(operation,{projectId,limit:100,...(after?{after}:{})},{signal});
  check(Array.isArray(page.items)&&page.items.length<=100,'invalid_backup_inventory');last=page;
  for(const file of page.items){check(file.projectId===projectId&&hex(file.id)&&!ids.has(file.id),'invalid_backup_inventory');ids.add(file.id);if(operation!=='data_file_list'||file.state!=='deleted')items.push(file);check(items.length<=MAX_FILES&&ids.size<=100000,'backup_inventory_too_large');}
  after=page.nextCursor;check(after===null||typeof after==='string'&&after.length>0&&!cursors.has(after),'invalid_backup_cursor');if(after)cursors.add(after);
 }while(after);
 return {items,last};
}
export function verifyDataBackup(backup){
 check(backup&&typeof backup==='object'&&hex(backup.id)&&backup.manifest?.schema===SCHEMA,'invalid_data_backup');
 const m=backup.manifest;check(digest(m)===backup.id&&typeof m.projectId==='string'&&m.projectId.length>0,'backup_manifest_corrupt');
 check(Array.isArray(m.files)&&m.files.length<=MAX_FILES&&Array.isArray(m.resources)&&m.resources.length<=MAX_FILES,'invalid_data_backup');
 const ids=new Set();let total=0;
 for(const file of m.files){check(hex(file.id)&&file.projectId===m.projectId&&hex(file.sha256)&&nameOk(file.name)&&Number.isSafeInteger(file.revision)&&file.revision>0&&!ids.has(file.id),'invalid_backup_file');ids.add(file.id);
  check(['ready','uploading','deleting','deleted'].includes(file.state)&&Number.isSafeInteger(file.bytes)&&file.bytes>0&&file.bytes<=MAX_FILE,'invalid_backup_file');if(file.state==='ready')total+=file.bytes;
 }
 check(total<=MAX_BYTES&&total===m.contentBytes&&m.resourceAuthority==='historical-only'&&m.pendingAuthority==='metadata-only','invalid_data_backup');
 for(const resource of m.resources)check(hex(resource.id)&&resource.projectId===m.projectId,'invalid_backup_resource');
 return m;
}
export async function exportDataBackup(client,{projectId,writeBlob,signal,fetch}={}){
 check(typeof writeBlob==='function','backup_writer_required');
 const original=await inventory(client,'data_file_list',projectId,{signal}),files=original.items.map(description).sort((a,b)=>a.id.localeCompare(b.id));
 let contentBytes=0;const written=new Set();
 for(const file of files.filter(f=>f.state==='ready')){
  check(hex(file.sha256)&&file.bytes<=MAX_FILE,'invalid_backup_file');contentBytes+=file.bytes;check(contentBytes<=MAX_BYTES,'backup_inventory_too_large');
  if(written.has(file.sha256))continue;
  const received=await downloadDataFile(client,{projectId,fileId:file.id},{signal,fetch});
  check(canonical(description(received.file))===canonical(file),'backup_source_changed');
  await writeBlob(file.sha256,received.bytes);written.add(file.sha256);
 }
 // A changing project produces no successful manifest. Partial local blobs
 // are harmless; only this last manifest marks a complete file snapshot.
 const current=await inventory(client,'data_file_list',projectId,{signal});
 check(canonical(current.items.map(description).sort((a,b)=>a.id.localeCompare(b.id)))===canonical(files),'backup_source_changed');
 const resources=(await inventory(client,'resource_instances',projectId,{signal})).items;
 const manifest={schema:SCHEMA,projectId,files,contentBytes,resources,resourceAuthority:'historical-only',pendingAuthority:'metadata-only'};
 const backup={id:digest(manifest),manifest};verifyDataBackup(backup);return backup;
}
export async function restoreDataBackup(client,{projectId,backup,readBlob,signal,fetch}={}){
 const manifest=verifyDataBackup(backup);check(typeof projectId==='string'&&projectId.length>0&&typeof readBlob==='function','invalid_restore_target');
 const files=manifest.files.filter(f=>f.state==='ready');
 // Validate every byte before the first remote write. Never start a restore
 // and only then discover that a later backup object is absent or corrupted.
 for(const file of files){signal?.throwIfAborted();const bytes=await readBlob(file.sha256,file.bytes);check(bytes instanceof Uint8Array&&bytes.length===file.bytes&&contentHash(bytes)===file.sha256,'backup_blob_corrupt');}
 const destination=await inventory(client,'data_file_list',projectId,{signal}),byId=new Map(destination.items.map(f=>[f.id,f]));
 const plan=files.map(file=>{const idempotencyKey='restore:'+digest({backupId:backup.id,fileId:file.id}).slice(7);return{file,idempotencyKey,id:digest({projectId,upload:idempotencyKey})};});
 let extraBytes=0,extraFiles=0;
 for(const item of plan){const old=byId.get(item.id);if(old){check(old.name===item.file.name&&old.sha256===item.file.sha256&&old.bytes===item.file.bytes&&['uploading','ready'].includes(old.state),'restore_original_conflict');}else{extraBytes+=item.file.bytes;extraFiles++;}}
 const {usage,limits}=destination.last;check(usage&&limits&&usage.bytes+extraBytes<=limits.bytes&&usage.count+extraFiles<=limits.files,'restore_capacity_exceeded');
 const restored=[];
 for(const item of plan){
  signal?.throwIfAborted();let file=byId.get(item.id);
  if(file?.state!=='ready'){
   const bytes=await readBlob(item.file.sha256,item.file.bytes);check(bytes.length===item.file.bytes&&contentHash(bytes)===item.file.sha256,'backup_blob_corrupt');
   file=await uploadDataFile(client,{projectId,name:item.file.name,bytes,idempotencyKey:item.idempotencyKey},{signal,fetch});
  }
  check(file.id===item.id&&file.state==='ready','restore_not_confirmed');restored.push({originalId:item.file.id,fileId:file.id});
 }
 return {backupId:backup.id,projectId,restored,pendingFilesSkipped:manifest.files.filter(f=>f.state!=='ready').length,resourcesRestored:false,financialActions:false};
}
