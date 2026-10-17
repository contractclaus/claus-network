import {managedDatabase,managedSchemaReady} from '../database-schema.js';
import {validateProgram} from '../isolated/runner.mjs';
import {parse} from 'acorn';
import type {LabDatabase,LabQuery} from '../lab-db.js';
import {BuilderStore} from '../builder-store.js';
import {assertBuilderDeployment} from '../builder-coordination.js';
import {hash,sha,target,validateManifest,validateChanges,patch,denyNewAuthority,OperationsInputRejection,type FileRef} from './policy.js';
import {OperationsHost} from './host.js';
import {handoffColumns} from './runtime-handoff.js';
export class OperationsStore{
 constructor(readonly db:LabDatabase,readonly host=new OperationsHost()){}
 async initialize(){if(managedDatabase())return managedSchemaReady();await this.db.query(`CREATE TABLE IF NOT EXISTS claus_operations_control(scope text PRIMARY KEY,enabled boolean NOT NULL DEFAULT false,revision integer NOT NULL DEFAULT 1,deployment text NOT NULL,manifest jsonb NOT NULL,crons jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS claus_operations_releases(id text PRIMARY KEY,request_hash text NOT NULL,scope text NOT NULL REFERENCES claus_operations_control(scope),base_revision integer NOT NULL,base_deployment text NOT NULL,manifest jsonb NOT NULL,files jsonb NOT NULL,source_hash text NOT NULL,changes jsonb NOT NULL,title text NOT NULL,goal text NOT NULL,build_id text UNIQUE,review_effect text,state text NOT NULL,deploy_started timestamptz,promote_started timestamptz,deployment jsonb,proof jsonb,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS claus_operations_handoffs(id text PRIMARY KEY,release_id text NOT NULL,origin_deployment text NOT NULL,target_deployment text NOT NULL,generation integer NOT NULL,run_id text,created_at timestamptz NOT NULL DEFAULT now());
 CREATE UNIQUE INDEX IF NOT EXISTS claus_operations_one_active ON claus_operations_releases(scope) WHERE state NOT IN ('active','rejected','blocked','rolled_back');
 ${handoffColumns}`);}
 async current(scope:string,q:LabQuery=this.db){target(scope);return(await q.query('SELECT * FROM claus_operations_control WHERE scope=$1',[scope])).rows[0]??null;}
 async get(id:string,q:LabQuery=this.db){const r=(await q.query('SELECT * FROM claus_operations_releases WHERE id=$1 OR build_id=$1',[id])).rows[0];if(!r)throw Error('operations_release_missing');return r;}
 async read({scope,id,path,offset=0}:any){
  if(id){const r=await this.get(id);return{id:r.id,scope:r.scope,state:r.state,sourceHash:r.source_hash,baseDeployment:r.base_deployment,deployment:r.deployment,proof:r.proof,buildId:r.build_id,reviewEffect:r.review_effect??null,...(r.scope==='native'?{runtimeHandoffs:(await this.db.query('SELECT id,generation,run_id,dispatch_state,observed_at FROM claus_operations_handoffs WHERE release_id=$1 ORDER BY created_at DESC',[r.id])).rows}:{})};}
  const c=await this.current(scope);if(!c)throw Error('operations_not_configured');
  if(path){if(typeof path!=='string'||!target(scope).paths.some(r=>r.test(path))||!Number.isSafeInteger(offset)||offset<0)throw Error('operations_path_denied');const ref=c.manifest.find((f:FileRef)=>f.path===path);if(!ref)throw Error('operations_file_missing');const content=await this.host.read(scope,c.deployment,ref);return{scope,revision:c.revision,deployment:c.deployment,path,sha:ref.sha,content:content.slice(offset,offset+18000),nextOffset:offset+18000<content.length?offset+18000:null};}
  return{scope,enabled:c.enabled,revision:c.revision,deployment:c.deployment,files:c.manifest.filter((f:FileRef)=>target(scope).paths.some(r=>r.test(f.path))),recent:(await this.db.query('SELECT id,state,source_hash,deployment,updated_at FROM claus_operations_releases WHERE scope=$1 ORDER BY created_at DESC LIMIT 8',[scope])).rows,...(scope==='native'?{runtimeHandoffs:(await this.db.query('SELECT id,target_deployment,generation,run_id,dispatch_state,observed_at FROM claus_operations_handoffs WHERE target_deployment=$1 ORDER BY created_at DESC LIMIT 3',[c.deployment])).rows}:{})};
 }
 async propose(requestId:string,input:any,builder:BuilderStore){
  if(!input||Object.keys(input).some(k=>!['scope','expectedRevision','title','goal','changes'].includes(k))||!Number.isSafeInteger(input.expectedRevision)||typeof input.title!=='string'||!input.title.trim()||input.title.length>120||typeof input.goal!=='string'||!input.goal.trim()||input.goal.length>2400)throw new OperationsInputRejection('operations_input_invalid','Provide the current expectedRevision, a title up to 120 characters, a goal up to 2400 characters and only supported fields.');
  validateChanges(input.scope,input.changes);const id='op_'+hash(requestId).slice(0,24),requestHash=hash(input),old=(await this.db.query('SELECT * FROM claus_operations_releases WHERE id=$1',[id])).rows[0];if(old){if(old.request_hash!==requestHash)throw Error('operations_request_conflict');return old;}
  const c=await this.current(input.scope);if(!c?.enabled||c.revision!==input.expectedRevision)throw Error('operations_disabled_or_revision_conflict');validateManifest(c.manifest);await this.host.baseline(input.scope,c.deployment,c.manifest);
  const files:{path:string;before:string;content:string}[]=[],manifest:FileRef[]=structuredClone(c.manifest);
  for(const change of input.changes){const ref=manifest.find(f=>f.path===change.path);if(!ref)throw Error('operations_existing_file_required');const before=await this.host.read(input.scope,c.deployment,ref),content=patch(before,change);denyNewAuthority(before,content);if(input.scope!=='web'){
   try{parse(validateProgram(change.path==='src/application/main.js'?{version:2,lines:content.split('\n')}:JSON.parse(content)),{ecmaVersion:'latest',sourceType:'script'});}
   catch{throw new OperationsInputRejection('operations_source_invalid','Correct the syntax in this exact isolated script before submitting. No build or review was created.');}
  }files.push({path:change.path,before,content});ref.sha=sha(content);ref.size=Buffer.byteLength(content);}
  if(Buffer.byteLength(JSON.stringify(files))>250000)throw Error('operations_review_source_too_large');
  const sourceHash=hash(manifest);
  const build=await builder.create('operations:'+id,input.title,input.goal,'claus','source',undefined,'javascript','operations',{
   prepare:async q=>{await assertBuilderDeployment(q);const fresh=await this.current(input.scope,q);if(!fresh?.enabled||fresh.revision!==input.expectedRevision)throw Error('operations_disabled_or_revision_conflict');},
   save:async(q,buildId)=>{await q.query("INSERT INTO claus_operations_releases(id,request_hash,scope,base_revision,base_deployment,manifest,files,source_hash,changes,title,goal,build_id,state) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9::jsonb,$10,$11,$12,'review_pending')",[id,requestHash,input.scope,c.revision,c.deployment,JSON.stringify(manifest),JSON.stringify(files),sourceHash,JSON.stringify(input.changes),input.title,input.goal,buildId]);await q.query("UPDATE claus_builds SET status='queued' WHERE id=$1",[buildId]);}
  });return this.get(build.id);
 }
 async mark(id:string,state:string,fields:any={}){await this.db.query('UPDATE claus_operations_releases SET state=$2,deployment=COALESCE($3::jsonb,deployment),proof=COALESCE($4::jsonb,proof),review_effect=COALESCE($5,review_effect),updated_at=now() WHERE id=$1',[id,state,fields.deployment?JSON.stringify(fields.deployment):null,fields.proof?JSON.stringify(fields.proof):null,fields.reviewEffect??null]);}
 async rollback(id:string,expectedRevision:number){return this.db.transaction(async q=>{
  await q.query('SELECT pg_advisory_xact_lock(6041010)');await assertBuilderDeployment(q);const r=await this.get(id,q),c=await this.current(r.scope,q);
  if(!c?.enabled||c.revision!==expectedRevision||c.deployment!==r.deployment?.id||r.state!=='active')throw Error('operations_rollback_conflict');
  await q.query("UPDATE claus_operations_releases SET state='rollback_pending',updated_at=now() WHERE id=$1",[r.id]);
  if(!(await q.query("UPDATE claus_builds SET status='queued',next_at=now() WHERE id=$1 AND (lease_until IS NULL OR lease_until<now()) RETURNING id",[r.build_id])).rows.length)throw Error('operations_worker_busy');return{id:r.id,buildId:r.build_id,state:'rollback_pending'};
 });}
 async finishRollback(id:string,_proof:any){const r=await this.get(id);return this.host.finishRollback(r.scope,r.id);}
 async beginRollback(id:string,previous:any){return this.db.transaction(async q=>{
  await q.query('SELECT pg_advisory_xact_lock(6041010)');await assertBuilderDeployment(q);
  const r=await this.get(id,q),c=await this.current(r.scope,q);
  if(!c?.enabled||!rollbackBaseCurrent(r,c))throw Error('operations_rollback_conflict');
  if(r.state!=='rollback_pending')return false;
  await q.query("UPDATE claus_operations_releases SET state='rolling_back',proof=$2::jsonb,updated_at=now() WHERE id=$1",[id,JSON.stringify({...r.proof,rollback:{startedAt:new Date().toISOString(),previous}})]);
  return true;
 });}
 async begin(id:string,kind:'deploy'|'promote'){
  const col=kind==='deploy'?'deploy_started':'promote_started';return this.db.transaction(async q=>{await q.query('SELECT pg_advisory_xact_lock(6041010)');await assertBuilderDeployment(q);const r=await this.get(id,q),c=await this.current(r.scope,q);if(!c?.enabled||c.revision!==r.base_revision||c.deployment!==r.base_deployment)throw Error('operations_base_changed');return(await q.query(`UPDATE claus_operations_releases SET ${col}=now() WHERE id=$1 AND ${col} IS NULL RETURNING id`,[id])).rows.length===1;});
 }
 async activate(id:string,_proof:any){const r=await this.get(id);return this.host.activate(r.scope,r.id);}
}
function rollbackBaseCurrent(r:any,c:any){
 return c?.deployment===r.base_deployment&&c.revision===r.base_revision || c?.deployment===r.deployment?.id&&c.revision===r.base_revision+1;
}
