#!/usr/bin/env node
import {privateKeyToAccount} from 'viem/accounts';
import {createAgentClient} from './agent-client.mjs';
import {readFile,open,stat} from 'node:fs/promises';
import {createClient} from './sdk.mjs';
import {API_VERSION,ROUTES} from './contract.mjs';
const [command,operation,inputPath,...extra]=process.argv.slice(2);
const credentialOperations=new Set(['auth_session','credential_create','credential_rotate']);
const usage='Usage: claus-network operations\n       claus-network describe OPERATION\n       claus-network call OPERATION [input.json]\n\noperations and describe read the bundled API schema without connecting or loading credentials.\nSet CLAUS_NETWORK_URL and either CLAUS_NETWORK_TOKEN_FILE or a private CLAUS_NETWORK_IDENTITY_FILE for automatic login.\nCredential responses require CLAUS_NETWORK_NEW_TOKEN_FILE.';
const describe=route=>({name:route.name,method:route.method,path:route.path,
 authentication:route.public?'none':'bearer',credentialFileRequired:credentialOperations.has(route.name)});
if((command==='--help'||command==='help')&&!operation){
 console.log(usage);
}else if(command==='operations'&&!operation){
 console.log(JSON.stringify({apiVersion:API_VERSION,operations:ROUTES.map(describe)},null,2));
}else if(command==='describe'&&operation&&!inputPath){
 const route=ROUTES.find(route=>route.name===operation);
 if(route)console.log(JSON.stringify({apiVersion:API_VERSION,...describe(route),inputSchema:route.inputSchema},null,2));
 else{console.error('Unknown operation. Run claus-network operations.');process.exitCode=2;}
}else if(command!=='call'||!operation||extra.length){
 console.error(usage);
 process.exitCode=2;
}else if(!ROUTES.some(route=>route.name===operation)){
 console.error('Unknown operation. Run claus-network operations.');
 process.exitCode=2;
}else{
 let destination;
 try{
  const tokenPath=process.env.CLAUS_NETWORK_TOKEN_FILE;
  const token=tokenPath?(await readFile(tokenPath,'utf8')).trim():undefined;
  let client=createClient({origin:process.env.CLAUS_NETWORK_URL,token});
  if(process.env.CLAUS_NETWORK_IDENTITY_FILE){
   if(tokenPath)throw Error('Choose identity file or delegated token file');
   const file=process.env.CLAUS_NETWORK_IDENTITY_FILE,info=await stat(file);
   if((info.mode&0o077)!==0)throw Error('Identity file must be private (chmod 600)');
   const {privateKey}=JSON.parse(await readFile(file,'utf8'));
   if(!/^0x[0-9a-fA-F]{64}$/.test(privateKey??''))throw Error('Invalid identity file');
   client=createAgentClient({origin:process.env.CLAUS_NETWORK_URL,account:privateKeyToAccount(privateKey)});
  }
  const input=inputPath?JSON.parse(await readFile(inputPath,'utf8')):{};
  if(credentialOperations.has(operation)){
   if(!process.env.CLAUS_NETWORK_NEW_TOKEN_FILE)throw Error('Set CLAUS_NETWORK_NEW_TOKEN_FILE before issuing a credential');
   // Fail before revoking/issuing anything if the destination is unavailable.
   destination=await open(process.env.CLAUS_NETWORK_NEW_TOKEN_FILE,'wx',0o600);
   await destination.writeFile('pending credential response\n');
   await destination.sync();
  }
  const value=await client.call(operation,input);
  if(value.token){await destination.truncate(0);await destination.write(value.token+'\n',0,'utf8');await destination.sync();delete value.token;}
  console.log(JSON.stringify(value,null,2));
 }catch(e){console.error(e.code??e.message);process.exitCode=1;}
 finally{await destination?.close();}
}
