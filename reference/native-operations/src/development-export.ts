import {Sandbox} from '@vercel/sandbox';
import {createHash} from 'node:crypto';
import {projectById} from './archive.js';
import {once,sql,actionProgress,settleAction,ConfirmedFailure} from './store.js';
import {createNetworkAccess} from './network-access.js';
import {sandboxFetch} from './sandbox-fetch.js';
import {digest} from './config.js';
import {DEVELOPMENT_LIMITS} from './development-execution.js';
const network=createNetworkAccess();
const canonical=(v:any):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const hash=(v:any)=>'sha256:'+createHash('sha256').update(canonical(v)).digest('hex');
export function developmentExportInput(a:any){
 if(!a||Object.keys(a).sort().join(',')!=='expectedProjectRevision,expectedVersion,networkProjectId,paths,projectId'||!/^p_[a-f0-9]{32}$/.test(a.projectId??'')||!/^prj_[a-zA-Z0-9-]{1,80}$/.test(a.networkProjectId??'')||![a.expectedVersion,a.expectedProjectRevision].every(n=>Number.isSafeInteger(n)&&n>=1)||!Array.isArray(a.paths)||!a.paths.length||a.paths.length>256||new Set(a.paths).size!==a.paths.length)throw new ConfirmedFailure('development_export_invalid');
 for(const path of a.paths)if(typeof path!=='string'||!path||path.length>180||!/^[a-zA-Z0-9_.@+/-]+$/.test(path)||path.startsWith('/')||path.includes('\\')||/[\x00-\x1f]/.test(path)||path.split('/').some((p:string)=>!p||p==='.'||p==='..'))throw new ConfirmedFailure('development_export_path_invalid');return a;
}
export function developmentSnapshotId(files:{path:string;content:string}[]){return hash(files.map(f=>({path:f.path,hash:hash(f)})).sort((a,b)=>a.path.localeCompare(b.path,'en')));}
async function exported(snapshotId:string,paths:string[]){
 const box=await Sandbox.create({source:{type:'snapshot',snapshotId},timeout:60000,networkPolicy:'deny-all',env:{},fetch:sandboxFetch});
 try{
  const session=box.currentSession();
  await session.writeFiles([{path:'/tmp/claus-export-paths.json',content:Buffer.from(JSON.stringify(paths))},{path:'/tmp/claus-export.mjs',content:Buffer.from(`import fs from 'node:fs';import path from 'node:path';const root=fs.realpathSync('/vercel/sandbox/project');let total=0;const files=JSON.parse(fs.readFileSync('/tmp/claus-export-paths.json','utf8')).map(p=>{const full=fs.realpathSync(path.join(root,p));if(!full.startsWith(root+'/'))throw Error('export_path_outside_project');const stat=fs.statSync(full);if(!stat.isFile()||stat.size>1000000)throw Error('export_file_too_large');total+=stat.size;if(total>3000000)throw Error('export_too_large');return {path:p,content:new TextDecoder('utf-8',{fatal:true}).decode(fs.readFileSync(full))};});const text=JSON.stringify(files);if(Buffer.byteLength(text)>3200000)throw Error('export_too_large');fs.writeFileSync('/tmp/claus-export.json',text);`)}]);
  const command=await session.runCommand({cmd:'/usr/bin/env',args:['-i','PATH=/vercel/sandbox/bin:/vercel/runtimes/node24/bin:/usr/local/bin:/usr/bin:/bin','node','/tmp/claus-export.mjs']});
  if(command.exitCode!==0)throw new ConfirmedFailure('development_export_files_unavailable');
  const bytes=await session.readFileToBuffer({path:'/tmp/claus-export.json'});if(!bytes||bytes.byteLength>3200000)throw new ConfirmedFailure('development_export_too_large');const files=JSON.parse(bytes.toString());if(!Array.isArray(files)||files.length!==paths.length||files.some((f:any,i:number)=>f.path!==paths[i]||typeof f.content!=='string'))throw new ConfirmedFailure('development_export_invalid');return files;
 }finally{await box.stop().catch(()=>{});}
}
export async function stageDevelopment(id:string,value:any){
 const input=developmentExportInput(value),db=sql(),inputHash=digest(input);
 const admit=async()=>{
  const [,rows]=await db.transaction([db`SELECT pg_advisory_xact_lock(746201603)`,db`WITH admitted AS (SELECT 1 WHERE (SELECT count(*) FROM claus_actions WHERE kind IN ('development','development_export') AND created_at>=date_trunc('day',now()))<${DEVELOPMENT_LIMITS.daily} AND (SELECT count(*) FROM claus_actions WHERE kind IN ('development','development_export') AND status NOT IN ('completed','failed'))<${DEVELOPMENT_LIMITS.active}) INSERT INTO claus_actions(id,kind,input_hash,status,input,visibility) SELECT ${id},'development_export',${inputHash},'pending',${JSON.stringify(input)}::jsonb,'private_network' FROM admitted ON CONFLICT DO NOTHING RETURNING id`]);
  if(!rows.length&&!(await db`SELECT id FROM claus_actions WHERE id=${id}`).length)throw new ConfirmedFailure('development_capacity_reached');return rows;
 };
 return once(id,'development_export',input,async()=>{
  const project=await projectById(input.projectId);if(!project||project.version!==input.expectedVersion||!project.snapshot_id)throw new ConfirmedFailure('development_project_version_changed');
  // Check project authority before spending any workspace execution time.
  const remote=await network.call('project_get',{projectId:input.networkProjectId});if(remote.revision!==input.expectedProjectRevision)throw new ConfirmedFailure('development_network_project_changed');
  let files;try{files=await exported(project.snapshot_id,input.paths);}catch(error){if(error instanceof ConfirmedFailure)throw error;throw new ConfirmedFailure('development_read_failed_no_network_write');}
  if(Buffer.byteLength(canonical(files.map((f:any)=>({...f,hash:hash(f)}))))>3000000||files.some((f:any)=>!f.content.isWellFormed()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(f.content)))throw new ConfirmedFailure('development_export_invalid_text_or_size');
  const snapshotId=developmentSnapshotId(files),progress={snapshotId,networkProjectId:input.networkProjectId,workspaceSnapshotId:project.snapshot_id,paths:input.paths,phase:'snapshot_submitting'};
  await actionProgress(id,progress);
  const result=await network.call('snapshot_create',{projectId:input.networkProjectId,files,expectedProjectRevision:input.expectedProjectRevision});
  if(result.id!==snapshotId)throw Error('development_snapshot_identity_mismatch');
  return {projectId:input.networkProjectId,snapshotId,workspaceSnapshotId:project.snapshot_id,paths:input.paths,staged:true,published:false,next:'This is a private source snapshot, including build inputs. For release_create select only intended website files ending .html, .css, .js, .json or .svg and include index.html. Keep README.md, .cjs scripts, tests and package/lock inputs private unless intentionally publishing an eligible file. Then release_publish selects the website; project publication remains separate.'};
 },db,admit);
}
export async function reconcileDevelopmentExports(){
 const actions=await sql()`SELECT id,progress FROM claus_actions WHERE kind='development_export' AND status NOT IN ('completed','failed') ORDER BY created_at LIMIT 4`;
 for(const a of actions){const p=a.progress;if(!p?.snapshotId)continue;try{const v=await network.call('snapshot_get',{projectId:p.networkProjectId,snapshotId:p.snapshotId});if(v.id===p.snapshotId)await settleAction(a.id,{projectId:p.networkProjectId,snapshotId:p.snapshotId,workspaceSnapshotId:p.workspaceSnapshotId,paths:p.paths,staged:true,published:false,recovered:true});}catch{/* Original missing or inaccessible snapshot stays held, never resend. */}}
}
