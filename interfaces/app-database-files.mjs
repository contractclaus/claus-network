import {constants} from 'node:fs';
import {open,lstat,link,unlink,chmod} from 'node:fs/promises';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {databaseVerifier,verifyDatabaseManifest} from './app-database-backup.mjs';
const check=(ok,code)=>{if(!ok)throw Error(code);};
async function regular(file,maximum){const fd=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{const st=await fd.stat();check(st.isFile()&&st.size<=maximum,'invalid_database_backup_file');return fd;}catch(e){await fd.close();throw e;}}
async function consume(root,apply){
 const directory=await lstat(root);check(directory.isDirectory()&&!directory.isSymbolicLink(),'invalid_database_backup_directory');
 const mf=await regular(path.join(root,'manifest.json'),32768);let backup;try{backup=JSON.parse(await mf.readFile('utf8'));}finally{await mf.close();}
 const m=verifyDatabaseManifest(backup),data=await regular(path.join(root,m.databaseFile),m.bytes),verify=databaseVerifier(m.snapshot);let lines;
 try{check((await data.stat()).size===m.bytes,'database_backup_size_mismatch');lines=createInterface({input:data.createReadStream({autoClose:false}),crlfDelay:Infinity});
  for await(const line of lines){check(line.length>0&&Buffer.byteLength(line)<=131072,'invalid_database_backup_line');let row;try{row=JSON.parse(line);}catch{throw Error('invalid_database_backup_line');}verify.row(row);await apply?.(row);}
  const result=verify.finish();check(result.sha256===m.sha256&&result.bytes===m.bytes,'database_backup_bytes_changed');return {backupId:backup.id,projectId:m.snapshot.projectId,...result};
 }finally{lines?.close();await data.close();}
}
export const verifyAppDatabaseDirectory=root=>consume(root);
export async function recoverAppDatabase(root,target){
 const verified=await consume(root);const parent=await lstat(path.dirname(target));check(parent.isDirectory()&&!parent.isSymbolicLink(),'invalid_database_target');
 const temporary=target+'.partial-'+randomUUID();const fd=await open(temporary,'wx',0o600);await fd.close();let db,created=false;
 try{const {DatabaseSync}=await import('node:sqlite');db=new DatabaseSync(temporary);db.exec('PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE; CREATE TABLE app_documents(app_id TEXT NOT NULL,collection TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(app_id,collection,id)); CREATE TABLE claus_backup(key TEXT PRIMARY KEY,value TEXT NOT NULL);');
  const insert=db.prepare('INSERT INTO app_documents VALUES(?,?,?,?,?)');const recovered=await consume(root,row=>insert.run(verified.projectId,row.collection,row.id,row.revision,JSON.stringify(row.value)));check(recovered.backupId===verified.backupId&&recovered.sha256===verified.sha256,'database_backup_changed');
  db.prepare('INSERT INTO claus_backup VALUES(?,?)').run('manifest',JSON.stringify({...verified,mode:'offline-recovery',networkAuthority:false,financialActions:false,executionEnabled:false}));db.exec('COMMIT;');check(db.prepare('PRAGMA integrity_check').get().integrity_check==='ok','database_recovery_corrupt');db.close();db=null;
  const file=await open(temporary,'r+');try{await file.sync();}finally{await file.close();}await chmod(temporary,0o600);await link(temporary,target);created=true;return {...verified,target,offline:true,networkAuthority:false,financialActions:false};
 }finally{db?.close();await unlink(temporary).catch(()=>{});if(!created){/* The existing target, if any, is never overwritten. */}}
}
