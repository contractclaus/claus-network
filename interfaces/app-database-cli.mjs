#!/usr/bin/env node
import {constants} from 'node:fs';
import {open,mkdir,unlink} from 'node:fs/promises';
import path from 'node:path';
import {privateKeyToAccount} from 'viem/accounts';
import {createClient} from './sdk.mjs';
import {createAgentClient} from './agent-client.mjs';
import {exportAppDatabase} from './app-database-backup.mjs';
import {verifyAppDatabaseDirectory,recoverAppDatabase} from './app-database-files.mjs';
const [command,arg1,arg2,...extra]=process.argv.slice(2),usage='Usage: claus-app-db backup PROJECT DIRECTORY\n       claus-app-db verify DIRECTORY\n       claus-app-db recover DIRECTORY FILE.sqlite\n\nBackup uses CLAUS_NETWORK_IDENTITY_FILE or CLAUS_NETWORK_TOKEN_FILE. Recover creates an offline database and never reconnects wallets or executes work.';
async function client(){const identity=process.env.CLAUS_NETWORK_IDENTITY_FILE,token=process.env.CLAUS_NETWORK_TOKEN_FILE; if(Boolean(identity)===Boolean(token))throw Error('choose_one_private_credential_file');const fd=await open(identity??token,constants.O_RDONLY|constants.O_NOFOLLOW);let value;try{const st=await fd.stat();if(!st.isFile()||st.size>16384||(st.mode&0o077)!==0)throw Error('credential_file_must_be_private');value=await fd.readFile('utf8');}finally{await fd.close();}
 const origin=process.env.CLAUS_NETWORK_URL;if(token)return createClient({origin,token:value.trim()});const {privateKey}=JSON.parse(value);if(!/^0x[a-fA-F0-9]{64}$/.test(privateKey??''))throw Error('invalid_identity');return createAgentClient({origin,account:privateKeyToAccount(privateKey)});}
async function write(file,value){const fd=await open(file,'wx',0o600);try{await fd.writeFile(value);await fd.sync();}finally{await fd.close();}}
if(!command||['help','--help'].includes(command))console.log(usage);
else try{if(extra.length||!['backup','verify','recover'].includes(command)||!arg1||(['backup','recover'].includes(command)?!arg2:!!arg2))throw Error('invalid_command');
 if(command==='backup'){const c=await client(),root=path.resolve(arg2);await mkdir(root,{mode:0o700});await write(path.join(root,'incomplete.json'),JSON.stringify({complete:false,projectId:arg1})+'\n');const db=await open(path.join(root,'database.ndjson'),'wx',0o600);let backup;try{backup=await exportAppDatabase(c,{projectId:arg1,write:line=>db.writeFile(line)});await db.sync();}finally{await db.close();}await write(path.join(root,'manifest.json'),JSON.stringify(backup,null,2)+'\n');await unlink(path.join(root,'incomplete.json'));console.log(JSON.stringify({complete:true,backupId:backup.id,projectId:arg1,rows:backup.manifest.rows,bytes:backup.manifest.bytes}));}
 else if(command==='verify')console.log(JSON.stringify({valid:true,...await verifyAppDatabaseDirectory(path.resolve(arg1))}));
 else console.log(JSON.stringify(await recoverAppDatabase(path.resolve(arg1),path.resolve(arg2))));
}catch(e){const code=e.code??e.message;console.error(/^[a-zA-Z0-9_]{1,100}$/.test(code)?code:'app_database_backup_failed');process.exitCode=1;}
