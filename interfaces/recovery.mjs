// Owner-controlled offline recovery. No imported record grants live authority.
import {createHash} from 'node:crypto';
import {open,mkdir,chmod,stat,writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {DatabaseSync} from 'node:sqlite';
import {exportApplication} from './app-events.mjs';
import {digest,sourcePath,requireThat} from '../src/shared/index.mjs';

const FORMAT='claus-recovery/1',MAX_BYTES=512_000_000,MAX_LINE=3_300_000,MAX_PAGES=2400,MAX_ROWS=57000;
const check=(v,message='invalid_recovery_bundle')=>requireThat(v,message);
const equal=(a,b)=>digest(a)===digest(b);
const collections=m=>['versions','members','tasks',...m.manifest.collections.map(c=>'records:'+c.id),'events'];

export async function exportRecovery(client,{projectId,snapshotId,directory,signal}={}){
 check(typeof projectId==='string'&&typeof directory==='string','invalid_recovery_input');
 await mkdir(directory,{mode:0o700}); // Exclusive directory. Never overwrite an existing backup.
 const file=await open(path.join(directory,'bundle.ndjson'),'wx',0o600),hash=createHash('sha256');
 let bytes=0,pages=0,records=0,complete=false;
 const line=async value=>{const text=JSON.stringify(value)+'\n';bytes+=Buffer.byteLength(text);check(bytes<=MAX_BYTES&&Buffer.byteLength(text)<=MAX_LINE,'recovery_too_large');await file.writeFile(text);hash.update(text);};
 try{
  const project=await client.call('project_get',{projectId},{signal});
  check(project.id===projectId);
  await line({kind:'header',schema:FORMAT,projectId,createdAt:Date.now(),project,
   scope:'Owner snapshot. Checksums detect corruption, not independent authenticity. Imported history never grants credentials or replays work.'});
  let source=null;
  if(!snapshotId){
   let after='',latest,rounds=0;const seen=new Set();
   do{const page=await client.call('resource_list',{projectId,kind:'snapshots',limit:100,...(after?{after}:{})},{signal});
    check(++rounds<=11&&Array.isArray(page.items),'invalid_snapshot_listing');
    for(const s of page.items)if(!latest||s.createdAt>latest.createdAt||s.createdAt===latest.createdAt&&s.id>latest.id)latest=s;
    after=page.nextCursor;check(!after||!seen.has(after),'invalid_snapshot_cursor');seen.add(after);
   }while(after);
   snapshotId=latest?.id;
  }
  if(snapshotId)source=await client.call('project_export',{projectId,snapshotId},{signal});
  await line({kind:'source',value:source});
  let hasApp=false;
  try{
   for await(const page of exportApplication(client,{projectId,signal})){
    check(!signal?.aborted,'recovery_interrupted');hasApp=true;
    pages++;records+=page.items.length;check(pages<=MAX_PAGES&&records<=MAX_ROWS,'recovery_too_large');
    await line({kind:'app',value:page});
   }
  }catch(error){if(hasApp||error.code!=='not_found')throw error;}
  check(!signal?.aborted,'recovery_interrupted');
  const footer={kind:'end',sha256:hash.digest('hex'),pages,records,bytes,hasApp};
  await file.writeFile(JSON.stringify(footer)+'\n');await file.sync();complete=true;
  await writeFile(path.join(directory,'README.txt'),'Private Claus owner backup. Contains private records and member identifiers.\nRestore with: node interfaces/recovery-cli.mjs restore BACKUP_DIRECTORY NEW_DIRECTORY\nThe restore is an offline SQLite archive plus selected website source. No job, payment, membership, session, or permission is activated.\n'+JSON.stringify({projectId,pages,records,hasApp,sourceSnapshot:source?.snapshot?.id??null},null,2)+'\n',{flag:'wx',mode:0o600});
  return {projectId,pages,records,hasApp,sourceSnapshot:source?.snapshot?.id??null,sha256:footer.sha256};
 }finally{await file.close();if(!complete)await writeFile(path.join(directory,'INCOMPLETE.txt'),'Export did not finish. Retain for diagnosis; do not restore or append. Retry into a new directory.\n',{flag:'wx',mode:0o600});}
}

// The database contains historical data only. This intentionally does not
// implement an API accepting the original app credentials or execute tasks.
export async function restoreRecovery({directory,destination}={}){
 destination=path.resolve(destination);
 const input=path.join(directory,'bundle.ndjson'),info=await stat(input);check(info.size<=MAX_BYTES+1000&&info.isFile(),'recovery_too_large');
 await mkdir(destination,{mode:0o700});
 const dbFile=path.join(destination,'application.sqlite'),handle=await open(dbFile,'wx',0o600);await handle.close();
 const db=new DatabaseSync(dbFile);let success=false,header,source,manifest,version,previous=null,ended=false,seenSource=false,pages=0,records=0,bytes=0;
 const hash=createHash('sha256'),cursors=new Set();
 db.exec('BEGIN; CREATE TABLE metadata(id TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE records(collection TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(collection,id)); CREATE TABLE files(path TEXT PRIMARY KEY,hash TEXT NOT NULL,content TEXT NOT NULL);');
 const meta=db.prepare('INSERT INTO metadata VALUES(?,?)'),row=db.prepare('INSERT INTO records VALUES(?,?,?,?)'),file=db.prepare('INSERT INTO files VALUES(?,?,?)');
 const stream=createReadStream(input,{encoding:'utf8',highWaterMark:65536});let pendingBytes=0;
 // Reject oversized lines during streaming, before readline can accumulate them.
 stream.on('data',chunk=>{for(const piece of chunk.split(/(?<=\n)/)){pendingBytes+=Buffer.byteLength(piece);if(pendingBytes>MAX_LINE){stream.destroy(Error('recovery_line_too_large'));break;}if(piece.endsWith('\n'))pendingBytes=0;}});
 const lines=createInterface({input:stream,crlfDelay:Infinity});
 try{
  for await(const raw of lines){
   check(!ended&&raw.length>0);const value=JSON.parse(raw);
   if(value.kind==='end'){
    check(header&&seenSource&&value.sha256===hash.digest('hex')&&value.pages===pages&&value.records===records&&value.bytes===bytes&&value.hasApp===(pages>0));
    check(!pages||previous.nextCursor===null);ended=true;continue;
   }
   const text=raw+'\n';bytes+=Buffer.byteLength(text);check(bytes<=MAX_BYTES);hash.update(text);
   if(!header){check(value.kind==='header'&&value.schema===FORMAT&&value.projectId===value.project?.id);header=value;meta.run('project',JSON.stringify(value));continue;}
   if(value.kind==='source'){
    check(!seenSource&&pages===0);seenSource=true;source=value.value;
    if(source!==null){
     check(source.project?.id===header.projectId&&Array.isArray(source.files)&&source.files.length<=256&&source.snapshot?.projectId===header.projectId);
     check(equal(source.snapshot.files,source.files.map(f=>({path:f.path,hash:f.hash})))&&digest(source.snapshot.files)===source.snapshot.id);
     let total=0;for(const f of source.files){sourcePath(f.path);check(typeof f.content==='string'&&f.content.isWellFormed()&&Buffer.byteLength(f.content)<=1_000_000);check(digest({path:f.path,content:f.content})===f.hash);total+=Buffer.byteLength(JSON.stringify(f));file.run(f.path,f.hash,f.content);}check(total<=3_000_000);
     meta.run('source',JSON.stringify({snapshot:source.snapshot,exportedAt:source.exportedAt}));
    }continue;
   }
   check(value.kind==='app'&&seenSource);const p=value.value;
   check(p.schemaVersion==='claus-app-export/1'&&p.projectId===header.projectId&&p.manifest?.projectId===header.projectId&&Array.isArray(p.items)&&p.items.length<=25);
   pages++;records+=p.items.length;check(pages<=MAX_PAGES&&records<=MAX_ROWS,'recovery_too_large');
   if(!manifest){manifest=p.manifest;version=p.contentVersion;meta.run('app',JSON.stringify(manifest));meta.run('contentVersion',JSON.stringify(version));}
   check(p.contentVersion===version&&equal(manifest,p.manifest)&&typeof version==='string');
   const allowed=collections(manifest);check(allowed.includes(p.collection));
   if(previous){check(previous.nextCursor!==null);const i=allowed.indexOf(previous.collection),j=allowed.indexOf(p.collection);check(j===i||j===i+1);}else check(p.collection===allowed[0]);
   check(p.nextCursor===null||typeof p.nextCursor==='string');
   if(p.nextCursor!==null){check(!cursors.has(p.nextCursor));cursors.add(p.nextCursor);}else check(p.collection===allowed.at(-1));
   for(const r of p.items){check(typeof r.recordKey==='string'&&r.recordKey.length>0,'app_export_key_missing_update_server');check(Number.isSafeInteger(r.revision)&&r.revision>0);row.run(p.collection,r.recordKey,r.revision,JSON.stringify(r));}
   previous=p;
  }
  check(ended,'incomplete_recovery_bundle');
  meta.run('restore',JSON.stringify({at:Date.now(),mode:'offline-history-only',credentials:false,activeMemberships:false,executors:false,payments:false}));db.exec('COMMIT');
  const root=path.join(destination,'source');if(source?.files.length){await mkdir(root,{mode:0o700});for(const f of source.files){const output=path.resolve(root,f.path);check(output.startsWith(root+path.sep),'invalid_file_path');await mkdir(path.dirname(output),{recursive:true,mode:0o700});await writeFile(output,f.content,{flag:'wx',mode:0o600});}}
  await writeFile(path.join(destination,'README.txt'),'Claus offline recovery\n\napplication.sqlite contains historical app versions, records, members, tasks and events. The selected immutable source snapshot is in source/. All files are private.\n\nNo original credential, membership, task lease, payment, accepted-work certification or network permission becomes active here. Do not attach this archive directly to a live executor. Configure a new host, identity and permissions separately. Pending or uncertain jobs must be reconciled at their original operator, never replayed.\n\nChecksums detect corruption; this is an owner archive, not an operator-signed independent attestation. Keep it private.\nInspect: node interfaces/recovery-cli.mjs inspect RESTORE_DIRECTORY\nRead your data using any SQLite reader: SELECT collection,id,value FROM records;\n',{flag:'wx',mode:0o600});
  success=true;return {projectId:header.projectId,pages,records,files:source?.files.length??0,mode:'offline-history-only'};
 }finally{lines.close();stream.destroy();if(!success){try{db.exec('ROLLBACK');}catch{}await writeFile(path.join(destination,'INCOMPLETE.txt'),'Restore did not finish. Do not use this directory. Source backup is unchanged.\n',{flag:'wx',mode:0o600});}db.close();await chmod(dbFile,0o600);}
}

export async function inspectRecovery(directory){
 try{await stat(path.join(directory,'INCOMPLETE.txt'));throw Error('incomplete_recovery_bundle');}catch(e){if(e.code!=='ENOENT')throw e;}
 const db=new DatabaseSync(path.join(directory,'application.sqlite'),{readOnly:true});
 try{return {mode:JSON.parse(db.prepare("SELECT value FROM metadata WHERE id='restore'").get().value).mode,
  projectId:JSON.parse(db.prepare("SELECT value FROM metadata WHERE id='project'").get().value).projectId,
  collections:db.prepare('SELECT collection,count(*) AS count FROM records GROUP BY collection ORDER BY collection').all(),files:db.prepare('SELECT count(*) AS count FROM files').get().count};}finally{db.close();}
}
