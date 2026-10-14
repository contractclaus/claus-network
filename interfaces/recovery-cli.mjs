#!/usr/bin/env node
import {readFile,stat} from 'node:fs/promises';
import {privateKeyToAccount} from 'viem/accounts';
import {createAgentClient} from './agent-client.mjs';
import {createClient} from './sdk.mjs';
import {exportRecovery,restoreRecovery,inspectRecovery} from './recovery.mjs';
const [command,first,second,third,...extra]=process.argv.slice(2);
const usage='Usage: node interfaces/recovery-cli.mjs export PROJECT_ID NEW_BACKUP_DIRECTORY [SNAPSHOT_ID]\n       node interfaces/recovery-cli.mjs restore BACKUP_DIRECTORY NEW_RESTORE_DIRECTORY\n       node interfaces/recovery-cli.mjs inspect RESTORE_DIRECTORY\nExport uses CLAUS_NETWORK_IDENTITY_FILE or CLAUS_NETWORK_TOKEN_FILE with the project owner. Restore and inspect work offline and never activate jobs or permissions.';
try{
 if(command==='help'||command==='--help'||!command)console.log(usage);
 else if(command==='export'&&first&&second&&!extra.length){
  const identityFile=process.env.CLAUS_NETWORK_IDENTITY_FILE,tokenFile=process.env.CLAUS_NETWORK_TOKEN_FILE;
  if(!!identityFile===!!tokenFile)throw Error('Choose one private owner identity or token file');
  const file=identityFile??tokenFile;if(((await stat(file)).mode&0o077)!==0)throw Error('Credential file must be private (chmod 600)');
  const origin=process.env.CLAUS_NETWORK_URL;
  const client=identityFile?createAgentClient({origin,account:privateKeyToAccount(JSON.parse(await readFile(file,'utf8')).privateKey)}):createClient({origin,token:(await readFile(file,'utf8')).trim()});
  console.log(JSON.stringify(await exportRecovery(client,{projectId:first,directory:second,snapshotId:third}),null,2));
 }else if(command==='restore'&&first&&second&&!third)console.log(JSON.stringify(await restoreRecovery({directory:first,destination:second}),null,2));
 else if(command==='inspect'&&first&&!second)console.log(JSON.stringify(await inspectRecovery(first),null,2));
 else throw Error(usage);
}catch(e){console.error(e.code??e.message);process.exitCode=1;}
