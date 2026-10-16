import {createHash} from 'node:crypto';
import {Sandbox} from '@vercel/sandbox';
import {sandboxFetch} from './sandbox-fetch.js';
import {experimentOutput} from './lab-experiment-output.js';

export const DEVELOPMENT_LIMITS=Object.freeze({files:64,sourceBytes:500000,seconds:300,daily:100,active:4});
export type DevelopmentInput={projectId?:string;expectedVersion?:number;title?:string;purpose?:string;command:string;files:{path:string;content:string}[];timeoutSeconds?:number};
export function developmentInput(value:any):DevelopmentInput {
 if(!value||typeof value!=='object'||Object.keys(value).some(k=>!['projectId','expectedVersion','title','purpose','command','files','timeoutSeconds'].includes(k)))throw Error('development_input_invalid');
 if(typeof value.command!=='string'||!value.command.trim()||value.command.length>12000||!Array.isArray(value.files)||value.files.length>DEVELOPMENT_LIMITS.files)throw Error('development_input_invalid');
 if(value.projectId!==undefined?(!/^p_[a-f0-9]{32}$/.test(value.projectId)||!Number.isSafeInteger(value.expectedVersion)||value.expectedVersion<1):(value.expectedVersion!==undefined||typeof value.title!=='string'||!value.title.trim()||value.title.length>240||typeof value.purpose!=='string'||!value.purpose.trim()||value.purpose.length>8000))throw Error('development_project_invalid');
 if(value.timeoutSeconds!==undefined&&(!Number.isInteger(value.timeoutSeconds)||value.timeoutSeconds<10||value.timeoutSeconds>DEVELOPMENT_LIMITS.seconds))throw Error('development_timeout_invalid');
 const paths=new Set<string>();let size=0;
 for(const f of value.files){if(!f||typeof f.path!=='string'||!f.path||f.path.length>240||f.path.startsWith('/')||f.path.includes('\\')||/[\x00-\x1f]/.test(f.path)||f.path.split('/').some((p:string)=>!p||p==='.'||p==='..')||paths.has(f.path)||typeof f.content!=='string')throw Error('development_file_invalid');paths.add(f.path);size+=Buffer.byteLength(f.content);}
 if(size>DEVELOPMENT_LIMITS.sourceBytes)throw Error('development_source_too_large');
 return value;
}
export const developmentName=(id:string)=>'claus-dev-'+createHash('sha256').update(id).digest('hex').slice(0,32);
const network={allow:['registry.npmjs.org','github.com','api.github.com','raw.githubusercontent.com','release-assets.githubusercontent.com','objects.githubusercontent.com','pypi.org','files.pythonhosted.org']};
type Save=(progress:any)=>Promise<void>;
export class DevelopmentExecution {
 constructor(readonly backend:Pick<typeof Sandbox,'create'|'get'>=Sandbox){}
 async run(id:string,input:DevelopmentInput,baseSnapshot:string,save:Save){
  developmentInput(input);const seconds=input.timeoutSeconds??100;
  let progress:any={name:developmentName(id),baseSnapshot,phase:'creating',deadline:new Date(Date.now()+(seconds+60)*1000).toISOString()},box:Sandbox|undefined;
  const record=async(value:any)=>{progress={...progress,...value};await save(progress);};await record({});
  try{
   // Each original effect gets its own copy. Concurrent work cannot mutate a
   // shared running VM; only a compare-and-swap publishes the new checkpoint.
   box=await this.backend.create({name:progress.name,source:{type:'snapshot',snapshotId:baseSnapshot},timeout:(seconds+60)*1000,resources:{vcpus:2},networkPolicy:network,persistent:true,snapshotExpiration:0,env:{},fetch:sandboxFetch});
   const session=box.currentSession();await record({phase:'writing',sessionId:session.sessionId});
   // A previous project may contain symlinks. Never write supplied files
   // through them: first validate parents and leaf within the guest itself.
   const payload=JSON.stringify(input.files);
   await session.writeFiles([{path:'/tmp/claus-development-input.json',content:Buffer.from(payload)},{path:'/tmp/claus-development-write.mjs',content:Buffer.from(`import fs from 'node:fs';import path from 'node:path';const root='/vercel/sandbox/project';fs.mkdirSync(root,{recursive:true});for(const f of JSON.parse(fs.readFileSync('/tmp/claus-development-input.json','utf8'))){let p=root;for(const part of f.path.split('/')){p=path.join(p,part);if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw Error('symlink_write_denied');}const dest=path.join(root,f.path);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,f.content);}`)}]);
   await record({phase:'command_starting'});
   const command=await session.runCommand({cmd:'/usr/bin/env',args:['-i','PATH=/vercel/sandbox/bin:/vercel/runtimes/node24/bin:/usr/local/bin:/usr/bin:/bin','HOME=/home/vercel-sandbox','timeout','--kill-after=3s',seconds+'s','bash','--noprofile','--norc','-c','node /tmp/claus-development-write.mjs && cd /vercel/sandbox/project &&\n'+input.command],detached:true});
   await record({phase:'command_running',commandId:command.cmdId});
   const result=await experimentOutput(command,AbortSignal.timeout(Math.max(1,Date.parse(progress.deadline)-Date.now())));
   await record({phase:'command_finished',commandResult:result});
   if(result.outputLimited)return {...result,checkpointSnapshotId:null,checkpointApplied:false,reason:'output_limit_command_termination_requested'};
   const checkpoint=await box.snapshot({expiration:0});
   const output={...result,checkpointSnapshotId:checkpoint.snapshotId,inputHash:createHash('sha256').update(JSON.stringify(input)).digest('hex'),baseSnapshot};
   await record({phase:'snapshotted',result:output});return output;
  }finally{if(box)await box.stop().catch(()=>{});}
 }
 async recover(action:any,save:Save){
  const p=action.progress?.execution;if(!p)return null;
  if(p.result)return p.result;
  // GET never resumes the VM and no execution command is sent during recovery.
  let box:Sandbox|undefined;
  try{
   box=await this.backend.get({name:p.name,resume:false,fetch:sandboxFetch});
   const session=box.currentSession();if(session.sessionId!==p.sessionId){box=undefined;return null;}
   let result=p.commandResult;
   if(!result&&p.commandId)result=await experimentOutput(await session.getCommand(p.commandId),AbortSignal.timeout(10000));
   if(!result)return null;
   if(result.outputLimited)return {...result,checkpointSnapshotId:null,checkpointApplied:false,reason:'output_limit_command_termination_requested'};
   await save({...p,phase:'command_finished',commandResult:result});
   const snapshotId=box.status==='stopped'&&box.currentSnapshotId!==p.baseSnapshot?box.currentSnapshotId:(await box.snapshot({expiration:0})).snapshotId;
   if(!snapshotId||snapshotId===p.baseSnapshot)return null;
   const output={...result,checkpointSnapshotId:snapshotId,inputHash:createHash('sha256').update(JSON.stringify(action.input)).digest('hex'),baseSnapshot:p.baseSnapshot};
   await save({...p,phase:'snapshotted',result:output});return output;
  }catch{return null;}finally{if(box)await box.stop().catch(()=>{});}
 }
}
