import {createHash} from 'node:crypto';
import {canonical,digest} from '../src/shared/index.mjs';
import {APP_DATABASE_BACKUP,DATABASE_LIMITS,databaseOrder,databaseVersion} from '../src/apps/database-backup.mjs';
const check=(ok,code)=>{if(!ok)throw Error(code);};
export function checkDatabaseRow(row){
 check(row&&Object.keys(row).sort().join(',')==='collection,id,revision,value'&&typeof row.collection==='string'&&row.collection.length>0&&row.collection.length<=256&&typeof row.id==='string'&&row.id.length>0&&row.id.length<=4096&&Number.isSafeInteger(row.revision)&&row.revision>0&&row.value!==undefined,'invalid_database_backup_row');
 check(Buffer.byteLength(canonical(row.value))<=65536,'invalid_database_backup_row');return row;
}
export function databaseVerifier(snapshot){
 check(snapshot?.schema===APP_DATABASE_BACKUP&&typeof snapshot.projectId==='string'&&snapshot.projectId.length>0&&/^sha256:[a-f0-9]{64}$/.test(snapshot.version??'')&&Number.isSafeInteger(snapshot.rows)&&snapshot.rows>0&&snapshot.rows<=DATABASE_LIMITS.rows&&snapshot.authority==='historical-only'&&snapshot.financialActions===false,'invalid_database_backup');
 let previous=null,count=0,bytes=0,metadata=[],app=false;const hash=createHash('sha256');
 return {
  row(input){const row=checkDatabaseRow(input);check(!previous||databaseOrder(previous,row)<0,'database_backup_order');const line=canonical(row)+'\n';bytes+=Buffer.byteLength(line);count++;check(count<=DATABASE_LIMITS.rows&&bytes<=DATABASE_LIMITS.bytes,'database_backup_too_large');hash.update(line);metadata.push({collection:row.collection,id:row.id,revision:row.revision});previous=row;if(row.collection==='meta'&&row.id==='app'){check(row.value.projectId===snapshot.projectId,'database_backup_project_mismatch');app=true;}return line;},
  finish(){check(app&&count===snapshot.rows&&databaseVersion(metadata)===snapshot.version,'database_backup_snapshot_mismatch');metadata=[];return {rows:count,bytes,sha256:'sha256:'+hash.digest('hex')};}
 };
}
export function verifyDatabaseManifest(value){check(value?.manifest?.snapshot&&digest(value.manifest)===value.id,'database_backup_manifest_corrupt');databaseVerifier(value.manifest.snapshot);check(value.manifest.databaseFile==='database.ndjson'&&/^sha256:[a-f0-9]{64}$/.test(value.manifest.sha256??'')&&Number.isSafeInteger(value.manifest.bytes)&&value.manifest.bytes>0&&value.manifest.bytes<=DATABASE_LIMITS.bytes&&value.manifest.rows===value.manifest.snapshot.rows,'invalid_database_backup');return value.manifest;}
export async function exportAppDatabase(client,{projectId,write,signal}={}){
 check(typeof write==='function','database_backup_writer_required');let cursor='',snapshot=null,verify=null,complete=false;const cursors=new Set();
 do{signal?.throwIfAborted();const page=await client.call('app_database_export',{projectId,limit:50,...(cursor?{after:cursor}:{})},{signal});check(page.snapshot?.projectId===projectId&&Array.isArray(page.items)&&page.items.length<=50,'invalid_database_backup_page');
  if(!snapshot){snapshot=page.snapshot;verify=databaseVerifier(snapshot);}else check(canonical(page.snapshot)===canonical(snapshot),'database_backup_snapshot_changed');
  for(const row of page.items)await write(verify.row(row));
  cursor=page.nextCursor;complete=page.complete;check(complete===(cursor===null)&&(!cursor||typeof cursor==='string'&&cursor.length<=4096&&!cursors.has(cursor)),'invalid_database_backup_cursor');if(cursor)cursors.add(cursor);
 }while(!complete);
 const verified=verify.finish(),manifest={snapshot,databaseFile:'database.ndjson',...verified};return {id:digest(manifest),manifest};
}
