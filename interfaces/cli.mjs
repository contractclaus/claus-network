#!/usr/bin/env node
import {readFile,open} from 'node:fs/promises';
import {createClient} from './sdk.mjs';
const [command,operation,inputPath]=process.argv.slice(2);
if(command!=='call'||!operation){
 console.error('Usage: claus-network call OPERATION [input.json]\nSet CLAUS_NETWORK_URL and CLAUS_NETWORK_TOKEN_FILE. Credential responses require CLAUS_NETWORK_NEW_TOKEN_FILE.');
 process.exitCode=2;
}else{
 let destination;
 try{
  const tokenPath=process.env.CLAUS_NETWORK_TOKEN_FILE;
  const token=tokenPath?(await readFile(tokenPath,'utf8')).trim():undefined;
  const client=createClient({origin:process.env.CLAUS_NETWORK_URL,token});
  const input=inputPath?JSON.parse(await readFile(inputPath,'utf8')):{};
  if(['auth_session','credential_create','credential_rotate'].includes(operation)){
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
