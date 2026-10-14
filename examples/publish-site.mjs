#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {privateKeyToAccount} from 'viem/accounts';
import {createAgentClient} from '../interfaces/agent-client.mjs';
import {publishSite} from '../interfaces/site.mjs';

const [directory,slug,name,...extra]=process.argv.slice(2);
if(!directory||!slug||!name||extra.length>1||extra.length&&extra[0]!=='--app'){console.error('Usage: CLAUS_NETWORK_IDENTITY_FILE=/private/identity.json node examples/publish-site.mjs ./public-site my-project "My project" [--app]');process.exitCode=2;}
else try {
  const source=await fs.realpath(directory),keyPath=await fs.realpath(process.env.CLAUS_NETWORK_IDENTITY_FILE??'');
  if(keyPath===source||keyPath.startsWith(source+path.sep))throw Error('Keep the identity file outside the published directory');
  if(((await fs.stat(keyPath)).mode&0o077)!==0)throw Error('Identity file must be private (chmod 600)');
  const {privateKey}=JSON.parse(await fs.readFile(keyPath,'utf8'));
  const account=privateKeyToAccount(privateKey),files=[];
  async function walk(relative='') {
    for(const entry of await fs.readdir(path.join(source,relative),{withFileTypes:true})){
      if(entry.name.startsWith('.')||entry.name==='node_modules')continue;
      if(entry.isSymbolicLink())throw Error('Do not publish symbolic links');
      const file=path.posix.join(relative,entry.name);
      if(entry.isDirectory())await walk(file);
      else if(/\.(html|css|js|json|svg)$/.test(file)){
        if(files.length>=256||(await fs.stat(path.join(source,file))).size>1000000)throw Error('Site exceeds publication limits');
        const content=await fs.readFile(path.join(source,file),'utf8');
        if(content.includes(privateKey))throw Error('A source file contains the private identity key');
        files.push({path:file,content});
      }
    }
  }
  await walk();
  let manifest;
  if(extra[0]==='--app'){
    manifest=JSON.parse(await fs.readFile(path.join(source,'claus-app.json'),'utf8'));
    const content=await fs.readFile(new URL('../interfaces/browser-app.js',import.meta.url),'utf8');
    const existing=files.find(f=>f.path==='claus-app.js');
    if(existing&&existing.content!==content)throw Error('claus-app.js is reserved for the included browser client');
    if(!existing)files.push({path:'claus-app.js',content});
  }
  const client=createAgentClient({account,origin:process.env.CLAUS_NETWORK_URL});
  const result=await publishSite({client,slug,name,files});
  if(manifest){
    const {configureApp}=await import('../interfaces/app.mjs');
    result.application=await configureApp(client,{projectId:result.projectId,manifest});
  }
  console.log(JSON.stringify(result,null,2));
}catch(error){console.error(error.code??error.message);process.exitCode=1;}
