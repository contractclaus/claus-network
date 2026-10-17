#!/usr/bin/env node
import {constants} from 'node:fs';
import {mkdir,lstat,open,unlink} from 'node:fs/promises';
import path from 'node:path';
import {privateKeyToAccount} from 'viem/accounts';
import {createClient} from './sdk.mjs';
import {createAgentClient} from './agent-client.mjs';
import {exportDataBackup,restoreDataBackup,verifyDataBackup} from './data-backup.mjs';
const [command,arg1,arg2,...extra]=process.argv.slice(2);
const usage='Usage: claus-data backup PROJECT DIRECTORY\n       claus-data restore PROJECT DIRECTORY\n       claus-data inspect DIRECTORY\n\nUses CLAUS_NETWORK_IDENTITY_FILE or CLAUS_NETWORK_TOKEN_FILE. Backups remain private local files. Restore copies only ready private data, never jobs, payments or servers.';
const regular=async(file,max)=>{
 const fd=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const stat=await fd.stat();if(!stat.isFile()||stat.size>max)throw Error('invalid_private_file');return await fd.readFile();}finally{await fd.close();}
};
async function directory(file){const stat=await lstat(file);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('invalid_backup_directory');}
async function client(){
 const identity=process.env.CLAUS_NETWORK_IDENTITY_FILE,token=process.env.CLAUS_NETWORK_TOKEN_FILE,origin=process.env.CLAUS_NETWORK_URL;
 if(Boolean(identity)===Boolean(token))throw Error('choose_one_private_credential_file');
 const file=identity??token,stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)throw Error('credential_file_must_be_private');
 const value=(await regular(file,16384)).toString('utf8');
 if(token)return createClient({origin,token:value.trim()});
 const {privateKey}=JSON.parse(value);if(!/^0x[0-9a-fA-F]{64}$/.test(privateKey??''))throw Error('invalid_identity');
 return createAgentClient({origin,account:privateKeyToAccount(privateKey)});
}
async function readBackup(root){await directory(root);await directory(path.join(root,'blobs'));const backup=JSON.parse((await regular(path.join(root,'manifest.json'),1024*1024)).toString('utf8'));verifyDataBackup(backup);return backup;}
async function writePrivate(file,bytes){const fd=await open(file,'wx',0o600);try{await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}}
if(['help','--help'].includes(command)||!command){console.log(usage);}
else try{
 if(extra.length||!['backup','restore','inspect'].includes(command)||!arg1||(command!=='inspect'&&!arg2)||(command==='inspect'&&arg2))throw Error('invalid_command');
 const root=path.resolve(command==='inspect'?arg1:arg2);
 if(command==='backup'){
  const c=await client();await mkdir(root,{mode:0o700});await mkdir(path.join(root,'blobs'),{mode:0o700});
  await writePrivate(path.join(root,'incomplete.json'),JSON.stringify({projectId:arg1,complete:false})+'\n');
  const backup=await exportDataBackup(c,{projectId:arg1,writeBlob:(sha,bytes)=>writePrivate(path.join(root,'blobs',sha.slice(7)),bytes)});
  await writePrivate(path.join(root,'manifest.json'),JSON.stringify(backup,null,2)+'\n');await unlink(path.join(root,'incomplete.json'));
  console.log(JSON.stringify({complete:true,backupId:backup.id,files:backup.manifest.files.filter(f=>f.state==='ready').length,bytes:backup.manifest.contentBytes}));
 }else{
  const backup=await readBackup(root),readBlob=(sha,expected)=>regular(path.join(root,'blobs',sha.slice(7)),expected);
  if(command==='restore')console.log(JSON.stringify(await restoreDataBackup(await client(),{projectId:arg1,backup,readBlob})));
  else{
   // Offline integrity check performs no authentication or API calls.
   const {createHash}=await import('node:crypto');
   for(const file of backup.manifest.files.filter(f=>f.state==='ready')){const b=await readBlob(file.sha256,file.bytes);if(b.length!==file.bytes||'sha256:'+createHash('sha256').update(b).digest('hex')!==file.sha256)throw Error('backup_blob_corrupt');}
   console.log(JSON.stringify({valid:true,backupId:backup.id,projectId:backup.manifest.projectId,bytes:backup.manifest.contentBytes,resources:backup.manifest.resources.length}));
  }
 }
}catch(e){console.error(/^[a-zA-Z0-9_]{1,100}$/.test(e.code??e.message)?(e.code??e.message):'data_backup_failed');process.exitCode=1;}
