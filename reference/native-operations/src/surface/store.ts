import {SurfaceHost} from './host.js';
import {managedDatabase,managedSchemaReady} from '../database-schema.js';
import type {LabInference} from '../lab-model.js';
import {completeModelOutput} from '../model-completion.js';
import type {LabDatabase,LabQuery} from '../lab-db.js';
import {assertBuilderDeployment} from '../builder-coordination.js';
import {BuilderStore} from '../builder-store.js';
import {hash,text} from '../lab-schema.js';
import {applyChanges,checkSource,initialSource,sourceHash,type SourceFile} from './source.js';
export class SurfaceStore{
 constructor(readonly db:LabDatabase){}
 async initialize(){if(managedDatabase())return managedSchemaReady();await this.db.query(`
 CREATE TABLE IF NOT EXISTS claus_surface_control(id boolean PRIMARY KEY DEFAULT true CHECK(id),enabled boolean NOT NULL DEFAULT false,revision integer NOT NULL DEFAULT 1,project_id text NOT NULL,active_id text NOT NULL,fallback_id text,last_checked timestamptz,failures integer NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS claus_surface_releases(id text PRIMARY KEY,request_hash text NOT NULL,base_revision integer NOT NULL,build_id text UNIQUE,files jsonb NOT NULL,source_hash text NOT NULL,title text NOT NULL,goal text NOT NULL,changes jsonb NOT NULL DEFAULT '[]',checks jsonb NOT NULL,review_effect text,state text NOT NULL,deploy_started timestamptz,deployment jsonb,proof jsonb,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
 `);}
 async current(q:LabQuery=this.db){return (await q.query('SELECT * FROM claus_surface_control WHERE id')).rows[0]??null;}
 async get(id:string,q:LabQuery=this.db){const row=(await q.query('SELECT * FROM claus_surface_releases WHERE id=$1 OR build_id=$1',[id])).rows[0];if(!row)throw Error('surface_release_missing');return row;}
 async bootstrap(projectId:string,deployment:any,proof:any){
  if(!/^prj_[A-Za-z0-9]+$/.test(projectId)||deployment?.state!=='READY'||proof?.sourceHash!==sourceHash(initialSource)||proof?.passed!==true)throw Error('surface_bootstrap_invalid');
  await this.initialize();
  return this.db.transaction(async q=>{await q.query('SELECT pg_advisory_xact_lock(6041414)');const old=await this.current(q);if(old)return old;
   await q.query("INSERT INTO claus_surface_releases(id,request_hash,base_revision,files,source_hash,title,goal,checks,state,deployment,proof) VALUES($1,$2,0,$3::jsonb,$2,'Original Network','Preserve existing public map',$4::jsonb,'active',$5::jsonb,$6::jsonb)",['sr_bootstrap_20261014_v2',sourceHash(initialSource),JSON.stringify(initialSource),JSON.stringify(await checkSource(initialSource)),JSON.stringify(deployment),JSON.stringify({...proof,origin:'operator_bootstrap'})]);
   return (await q.query("INSERT INTO claus_surface_control(id,project_id,active_id) VALUES(true,$1,'sr_bootstrap_20261014_v2') RETURNING *",[projectId])).rows[0];
  });
 }
 async setEnabled(_enabled:boolean,_revision:number):Promise<any>{throw Error('surface_control_operator_required');}
 async propose(requestId:string,input:any,builder:BuilderStore){
  if(!input||Object.keys(input).some(k=>!['expectedRevision','title','goal','changes'].includes(k))||!Number.isSafeInteger(input.expectedRevision))throw Error('surface_input_invalid');
  const title=text(input.title,120),goal=text(input.goal,2400),id='sr_'+hash(requestId).slice(0,24),requestHash=hash(input);
  const previous=(await this.db.query('SELECT * FROM claus_surface_releases WHERE id=$1',[id])).rows[0];if(previous){if(previous.request_hash!==requestHash)throw Error('surface_request_conflict');return previous;}
  const c=await this.current();if(!c?.enabled||c.revision!==input.expectedRevision)throw Error('surface_disabled_or_revision_conflict');
  const base=await this.get(c.active_id),files=applyChanges(base.files,input.changes),checks=await checkSource(files);
  const build=await builder.create('surface:'+id,title,goal,'claus','source',undefined,'javascript','surface',{
   prepare:async q=>{const latest=await this.current(q);if(!latest?.enabled||latest.revision!==input.expectedRevision)throw Error('surface_disabled_or_revision_conflict');},
   save:async(q,buildId)=>{await q.query("INSERT INTO claus_surface_releases(id,request_hash,base_revision,build_id,files,source_hash,title,goal,changes,checks,state) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10::jsonb,'review_pending')",[id,requestHash,c.revision,buildId,JSON.stringify(files),checks.sourceHash,title,goal,JSON.stringify(input.changes),JSON.stringify(checks)]);await q.query("UPDATE claus_builds SET status='queued' WHERE id=$1",[buildId]);}
  });
  return this.get(build.id);
 }
 async reviewEffect(buildId:string,effectId:string){await this.db.query('UPDATE claus_surface_releases SET review_effect=$2 WHERE build_id=$1 AND (review_effect IS NULL OR review_effect=$2)',[buildId,effectId]);}
 // Operator-only recovery. Never exposed as a model tool or automatic retry.
 // Retain every old effect and source; normal reservation limits apply again.
 async retryReview(requestId:string,id:string,expectedEffect:string){
  if(!/^[a-zA-Z0-9:_-]{1,120}$/.test(requestId)||!/^sr_[a-zA-Z0-9_]+$/.test(id)||!/^build_[a-z0-9]+:model:[1-9][0-9]*$/.test(expectedEffect))throw Error('surface_retry_invalid');
  return this.db.transaction(async q=>{
   await q.query('SELECT pg_advisory_xact_lock(6041010)');await assertBuilderDeployment(q);
   await q.query('SELECT pg_advisory_xact_lock(6041414)');
   const r=await this.get(id,q),c=await this.current(q),retries=r.proof?.reviewRetries??[];
   const prior=retries.find((x:any)=>x.requestId===requestId);
   if(prior){if(prior.previousEffect!==expectedEffect)throw Error('surface_retry_conflict');return {id:r.id,buildId:r.build_id,existing:true};}
   const p=(await q.query('SELECT * FROM claus_builds WHERE id=$1 FOR UPDATE',[r.build_id])).rows[0];
   const e=(await q.query('SELECT * FROM claus_build_effects WHERE id=$1 AND project_id=$2',[expectedEffect,r.build_id])).rows[0];
   if(!c?.enabled||c.revision!==r.base_revision||r.state!=='review_pending'||r.deploy_started||r.review_effect!==expectedEffect||p?.status!=='blocked'||p.lease_until&&new Date(p.lease_until)>new Date()||e?.kind!=='model'||e.status!=='completed'||e.output?.completion?.status!=='incomplete')throw Error('surface_retry_not_eligible');
   if((await q.query("SELECT 1 FROM claus_build_effects WHERE project_id=$1 AND status IN ('reserved','running','uncertain')",[r.build_id])).rows.length)throw Error('surface_retry_pending');
   if(retries.length>=2)throw Error('surface_retry_limit');
   const proof={...r.proof,reviewRetries:[...retries,{requestId,previousEffect:expectedEffect,at:new Date().toISOString()}]};
   await q.query('UPDATE claus_surface_releases SET review_effect=NULL,proof=$2::jsonb,updated_at=now() WHERE id=$1',[r.id,JSON.stringify(proof)]);
   await q.query("UPDATE claus_builds SET status='queued',summary='Operator-authorized review retry; previous receipts retained.',next_at=now(),updated_at=now() WHERE id=$1",[r.build_id]);
   return {id:r.id,buildId:r.build_id,existing:false};
  });
 }
 // Operator-only replay of interpretation, never of the paid request.
 async recoverReview(id:string,expectedEffect:string,inference:LabInference){
  if(!/^sr_[a-zA-Z0-9_]+$/.test(id)||!/^build_[a-z0-9]+:model:[1-9][0-9]*$/.test(expectedEffect))throw Error('surface_recovery_invalid');
  const initial=await this.get(id);
  if(initial.proof?.reviewRecovery?.effectId===expectedEffect)return {id,buildId:initial.build_id,existing:true};
  const e=(await this.db.query('SELECT * FROM claus_build_effects WHERE id=$1 AND project_id=$2',[expectedEffect,initial.build_id])).rows[0];
  if(initial.review_effect!==expectedEffect||e?.status!=='completed'||e.output?.completion?.status!=='incomplete')throw Error('surface_recovery_not_eligible');
  const recovered=await inference.reconcile({...e,amount:String(e.amount),createdAt:new Date(e.created_at).toISOString()});
  if(recovered.state!=='completed')throw Error('surface_recovery_unavailable');
  const output=recovered.result,proof=output?.recovery,receipt=output?.receipt;
  if(!completeModelOutput(output)||proof?.version!==1||proof.requestId!==e.id||proof.providerRequestId!==e.output.receipt?.providerRequestId||
    !/^[a-f0-9]{64}$/.test(proof.evidenceHash??'')||!/^[a-f0-9]{64}$/.test(proof.originalResponseHash??'')||
    hash(receipt)!==hash(e.output.receipt)||output.model!==e.input.model||
    JSON.parse(e.input.input?.[0]?.content??'{}').sourceHash!==initial.source_hash)throw Error('surface_recovery_receipt_mismatch');
  return this.db.transaction(async q=>{
   await q.query('SELECT pg_advisory_xact_lock(6041010)');await assertBuilderDeployment(q);await q.query('SELECT pg_advisory_xact_lock(6041414)');
   const r=await this.get(id,q),c=await this.current(q),p=(await q.query('SELECT * FROM claus_builds WHERE id=$1 FOR UPDATE',[r.build_id])).rows[0];
   if(r.proof?.reviewRecovery?.effectId===expectedEffect)return {id,buildId:r.build_id,existing:true};
   if(!c?.enabled||c.revision!==r.base_revision||r.source_hash!==initial.source_hash||r.state!=='review_pending'||r.deploy_started||r.review_effect!==expectedEffect||p?.status!=='blocked'||p.lease_until&&new Date(p.lease_until)>new Date())throw Error('surface_recovery_not_eligible');
   const proof={...r.proof,reviewRecovery:{effectId:expectedEffect,sourceHash:r.source_hash,output,at:new Date().toISOString()}};
   await q.query('UPDATE claus_surface_releases SET proof=$2::jsonb,updated_at=now() WHERE id=$1',[id,JSON.stringify(proof)]);
   await q.query("UPDATE claus_builds SET status='queued',summary='Recovered original authenticated review; no new purchase.',next_at=now(),updated_at=now() WHERE id=$1",[r.build_id]);
   return {id,buildId:r.build_id,existing:false};
  });
 }
 async mark(id:string,state:string,fields:{deployment?:any;proof?:any}={}){await this.db.query('UPDATE claus_surface_releases SET state=$2,deployment=COALESCE($3::jsonb,deployment),proof=COALESCE($4::jsonb,proof),updated_at=now() WHERE id=$1',[id,state,fields.deployment?JSON.stringify(fields.deployment):null,fields.proof?JSON.stringify(fields.proof):null]);}
 async beginDeploy(id:string){return this.db.transaction(async q=>{
  await q.query('SELECT pg_advisory_xact_lock(6041010)');await assertBuilderDeployment(q);
  await q.query('SELECT pg_advisory_xact_lock(6041414)');const c=await this.current(q),r=await this.get(id,q);
  if(!c?.enabled||c.revision!==r.base_revision)throw Error('surface_disabled_or_revision_conflict');
  return (await q.query("UPDATE claus_surface_releases SET deploy_started=now(),state='deploying' WHERE id=$1 AND deploy_started IS NULL AND state='approved' RETURNING id",[id])).rows.length===1;
 });}
 async activate(id:string,_proof:any){return new SurfaceHost().activate(id);}
 async read(path?:string,offset=0,id?:string){
  const control=await this.current();if(!control)return {configured:false};const release=await this.get(id??control.active_id);
  if(path){if(!Number.isSafeInteger(offset)||offset<0)throw Error('surface_offset_invalid');const file=release.files.find((f:SourceFile)=>f.path===path);if(!file)throw Error('surface_file_missing');return {id:release.id,revision:control.revision,sourceHash:release.source_hash,path,content:file.content.slice(offset,offset+18000),nextOffset:offset+18000<file.content.length?offset+18000:null};}
  const recent=(await this.db.query('SELECT id,build_id,title,state,checks,proof,created_at FROM claus_surface_releases ORDER BY created_at DESC LIMIT 8')).rows;
  const usage=await new BuilderStore(this.db).usage('claus');
  for(const r of recent){r.active=control.enabled&&control.active_id===r.id;r.build=usage.projects.find((p:any)=>p.id===r.build_id)??null;}
  const build=usage.projects.find((p:any)=>p.id===release.build_id)??null;
  return {control,release:{id:release.id,sourceHash:release.source_hash,state:release.state,active:control.enabled&&control.active_id===release.id,build,files:release.files.map((f:SourceFile)=>({path:f.path,characters:f.content.length})),proof:release.proof},recent,scope:'Isolated public Network UI and credential-free data transform. No wallet, Club, contract, controller or native-agent source changes.'};
 }
 async publicRelease(id?:string){
  const c=await this.current();if(!c)return null;const r=await this.get(id??c.active_id);
  if(!['approved','deploying','verified','active'].includes(r.state))return null;
  return {revision:c.revision,id:r.id,active:c.active_id===r.id,url:r.deployment?.url??null,sourceHash:r.source_hash,program:r.files.find((f:SourceFile)=>f.path==='server/network-data.js')?.content,enabled:c.enabled};
 }
}
