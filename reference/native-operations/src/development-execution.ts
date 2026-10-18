import {developmentShape,developmentNetwork} from './development-profile.js';
import {fundDevelopment} from './development-funding.js';
import {developmentTools,developmentToolClient} from './external/development-grant.js';
import {createHash} from 'node:crypto';
import {Sandbox} from '@vercel/sandbox';
import {developmentSandboxFetch} from './sandbox-fetch.js';
import {developmentOutput} from './development-output.js';
import {developmentSource,developmentWriter,type DevelopmentSource,type SourceFile} from './development-source.js';

import {DEVELOPMENT_LIMITS} from './development-limits.js';
export {DEVELOPMENT_LIMITS} from './development-limits.js';
export type DevelopmentInput={projectId?:string;expectedVersion?:number;title?:string;purpose?:string;command:string;files:{path:string;content:string}[];timeoutSeconds?:number;source?:DevelopmentSource;vcpus?:number;networkHosts?:string[];workId?:string};
export function developmentInput(value:any):DevelopmentInput {
 if(!value||typeof value!=='object'||Object.keys(value).some(k=>!['projectId','expectedVersion','title','purpose','command','files','timeoutSeconds','source','vcpus','networkHosts','workId'].includes(k)))throw Error('development_input_invalid');
 if(typeof value.command!=='string'||!value.command.trim()||value.command.length>12000||!Array.isArray(value.files)||value.files.length>DEVELOPMENT_LIMITS.files)throw Error('development_input_invalid');
 if(value.projectId!==undefined?(!/^p_[a-f0-9]{32}$/.test(value.projectId)||!Number.isSafeInteger(value.expectedVersion)||value.expectedVersion<1):(value.expectedVersion!==undefined||typeof value.title!=='string'||!value.title.trim()||value.title.length>240||typeof value.purpose!=='string'||!value.purpose.trim()||value.purpose.length>8000))throw Error('development_project_invalid');
 if(value.timeoutSeconds!==undefined&&(!Number.isInteger(value.timeoutSeconds)||value.timeoutSeconds<DEVELOPMENT_LIMITS.minSeconds||value.timeoutSeconds>DEVELOPMENT_LIMITS.seconds))throw Error('development_timeout_invalid');
 if(value.source!==undefined)developmentSource(value.source);developmentShape(value);
 const paths=new Set<string>();let size=0;
 for(const f of value.files){if(!f||typeof f.path!=='string'||!f.path||f.path.length>240||f.path.startsWith('/')||f.path.includes('\\')||/[\x00-\x1f]/.test(f.path)||f.path.split('/').some((p:string)=>!p||p==='.'||p==='..')||paths.has(f.path)||typeof f.content!=='string')throw Error('development_file_invalid');paths.add(f.path);size+=Buffer.byteLength(f.content);}
 if(size>DEVELOPMENT_LIMITS.sourceBytes)throw Error('development_source_too_large');
 return value;
}
export const developmentName=(id:string)=>'claus-dev-'+createHash('sha256').update(id).digest('hex').slice(0,32);
const network={allow:['registry.npmjs.org','github.com','api.github.com','raw.githubusercontent.com','release-assets.githubusercontent.com','objects.githubusercontent.com','pypi.org','files.pythonhosted.org']};
type Save=(progress:any)=>Promise<void>;
export class DevelopmentExecution {
 constructor(readonly backend:Pick<typeof Sandbox,'create'|'get'>=Sandbox,readonly funding=fundDevelopment,readonly waitMs=60000){}
 async run(id:string,input:DevelopmentInput,baseSnapshot:string,save:Save,importedFiles:SourceFile[]=[]){
  developmentInput(input);const seconds=input.timeoutSeconds??100,shape=developmentShape(input),extraHosts=await developmentNetwork(input);
  let progress:any={name:developmentName(id),baseSnapshot,phase:'funding',deadline:new Date(Date.now()+(seconds+60)*1000).toISOString()},box:Sandbox|undefined,keepRunning=false;
  const record=async(value:any)=>{progress={...progress,...value};await save(progress);};await record({});
  try{
   // Each original effect gets its own copy. Concurrent work cannot mutate a
   // shared running VM; only a compare-and-swap publishes the new checkpoint.
   const funding=await this.funding(id,shape.vcpus,seconds);await record({phase:'creating',funding,deadline:new Date(Date.now()+(seconds+60)*1000).toISOString()});
   const bridge=developmentTools(id,progress.deadline);
   const net={allow:[...new Set([...network.allow,...extraHosts,...(bridge?[bridge.host]:[])])]};
   box=await this.backend.create({name:progress.name,source:{type:'snapshot',snapshotId:baseSnapshot},timeout:(seconds+60)*1000,region:'iad1',resources:{vcpus:shape.vcpus},networkPolicy:net,persistent:true,snapshotExpiration:0,env:{},fetch:developmentSandboxFetch});
   const session=box.currentSession();await record({phase:'writing',sessionId:session.sessionId,shape:{...shape,networkHosts:net.allow}});
   // A previous project may contain symlinks. Never write supplied files
   // through them: first validate parents and leaf within the guest itself.
   const merged=new Map(importedFiles.map(f=>[f.path,f]));for(const f of input.files)merged.set(f.path,f);
   const payload=JSON.stringify([...merged.values()]);
   await session.writeFiles([{path:'/tmp/claus-tools.mjs',content:Buffer.from(developmentToolClient)},{path:'/tmp/claus-development-input.json',content:Buffer.from(payload)},{path:'/tmp/claus-development-write.mjs',content:Buffer.from(developmentWriter(!input.projectId))}]);
   await record({phase:'command_starting'});
   const command=await session.runCommand({cmd:'/usr/bin/env',args:['-i','PATH=/vercel/sandbox/bin:/vercel/runtimes/node24/bin:/usr/local/bin:/usr/bin:/bin','HOME=/home/vercel-sandbox',...(bridge?['CLAUS_TOOLS_URL='+bridge.url,'CLAUS_TOOLS_TOKEN='+bridge.token]:[]),'timeout','--kill-after=3s',seconds+'s','bash','--noprofile','--norc','-c','node /tmp/claus-development-write.mjs && cd /vercel/sandbox/project &&\n'+input.command],detached:true});
   await record({phase:'command_running',commandId:command.cmdId});
   const signal=AbortSignal.timeout(Math.min(this.waitMs,Math.max(1,Date.parse(progress.deadline)-Date.now())));let result;
   try{result=await developmentOutput(command,signal);}catch(error){
    if(!signal.aborted)throw error;
    keepRunning=true;await record({phase:'command_running',deferred:true});return {pending:true,actionId:id,sessionId:session.sessionId,commandId:command.cmdId,deadline:progress.deadline,shape,next:'Read development_status with this original actionId. The original command continues; do not submit it again.'};
   }
   await record({phase:'command_finished',commandResult:result});
   if(result.outputLimited)return {...result,checkpointSnapshotId:null,checkpointApplied:false,reason:'output_limit_command_termination_requested'};
   const checkpoint=await box.snapshot({expiration:0});
   const output={...result,funding:progress.funding,checkpointSnapshotId:checkpoint.snapshotId,inputHash:createHash('sha256').update(JSON.stringify(input)).digest('hex'),baseSnapshot};
   await record({phase:'snapshotted',result:output});return output;
  }finally{if(box&&!keepRunning)await box.stop().catch(()=>{});}
 }
 async recover(action:any,save:Save){
  const p=action.progress?.execution;if(!p)return null;
  if(p.result)return p.result;
  if(p.recoveryObservation?.state==='stopped_outcome_unknown'&&!p.commandResult)return null;
  if(p.phase==='funding'){try{const funding=await this.funding(action.id,developmentShape(action.input).vcpus,action.input.timeoutSeconds??100);return {exitCode:null,checkpointSnapshotId:null,checkpointApplied:false,resourceCreated:false,funding,reason:'funding_reconciled_no_command_dispatched'};}catch{return null;}}
  // GET never resumes the VM and no execution command is sent during recovery.
  let box:Sandbox|undefined,stopAfter=false;
  try{
   box=await this.backend.get({name:p.name,resume:false,fetch:developmentSandboxFetch});
   const session=box.currentSession();if(session.sessionId!==p.sessionId){box=undefined;return null;}
   let result=p.commandResult;
   if(!result&&p.commandId){
    const command=await session.getCommand(p.commandId);
    // Detached metadata can keep exitCode null until wait() observes completion.
    // Read the original output with a bound instead of waiting for VM shutdown.
    stopAfter=box.status!=='stopped'&&Date.now()>Date.parse(p.deadline)+30000;
    result=await developmentOutput(command,AbortSignal.timeout(10000));
   }
   if(!result)return null;stopAfter=true;
   if(result.outputLimited)return {...result,checkpointSnapshotId:null,checkpointApplied:false,reason:'output_limit_command_termination_requested'};
   await save({...p,phase:'command_finished',commandResult:result});
   const snapshotId=box.status==='stopped'&&box.currentSnapshotId!==p.baseSnapshot?box.currentSnapshotId:(await box.snapshot({expiration:0})).snapshotId;
   if(!snapshotId||snapshotId===p.baseSnapshot)return null;
   const output={...result,funding:p.funding,checkpointSnapshotId:snapshotId,inputHash:createHash('sha256').update(JSON.stringify(action.input)).digest('hex'),baseSnapshot:p.baseSnapshot};
   await save({...p,phase:'snapshotted',result:output});return output;
  }catch{
   if(box?.status==='stopped')await save({...p,recoveryObservation:{state:'stopped_outcome_unknown',observedAt:new Date().toISOString(),sessionId:p.sessionId,commandId:p.commandId??null,checkpointSnapshotId:box.currentSnapshotId&&box.currentSnapshotId!==p.baseSnapshot?box.currentSnapshotId:null,reason:'original_command_receipt_unavailable_after_stop'}});
   return null;
  }finally{if(box&&stopAfter)await box.stop().catch(()=>{});}
 }
}
