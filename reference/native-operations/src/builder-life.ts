import {sleep} from 'workflow';
import {start} from 'workflow/api';
import {builderStore,builderTick,readBuilder} from './builder-service.js';
import {configuration,journal} from './store.js';
import {builderEnabled,buildRuntime,builderRuntimeEnabled} from './builder-schema.js';
import {nextBuilderReconciliation,sentBuilderEffect} from './builder-worker.js';
import {FeedbackBuildStore} from './feedback-builds.js';
import {SiteFeatureStore,autonomyEnabled} from './site/feature-store.js';
import {SiteStore} from './site/store.js';
import {builderWorkEligible,type BuilderStore} from './builder-store.js';
import type {LabDatabase} from './lab-db.js';
import {feedbackSourceEligible} from './feedback-source.js';
import {BuilderDeploymentFence} from './builder-coordination.js';
import {hash} from './lab-schema.js';
import {builderDispatchRecord,builderTerminalStates as terminal} from './builder-progress.js';
async function workEnabled(store:BuilderStore,p:any,config:any){
 return builderWorkEligible(config)(p,store.db);
}
type StartDependencies={store:BuilderStore;configuration:()=>Promise<any>;start:typeof start;journal:typeof journal};
export async function startBuilder(id:string,deps:StartDependencies={store:builderStore(),configuration,start,journal}){
 const config=await deps.configuration(),p=await deps.store.detail(id),sent=sentBuilderEffect(p);
 if(!sent&&!await workEnabled(deps.store,p,config))return {state:'disabled'};
 if(!sent&&terminal.includes(p.status))return {state:p.status,id};
 // Route to the exact operator-pinned deployment, never an arbitrary latest
 // preview. The pinned code also rechecks its identity at each effect boundary.
 const active=await deps.store.coordination.active();
 if(!sent&&!active)try{await deps.store.coordination.assertCurrent();}catch(error){if(error instanceof BuilderDeploymentFence)return {state:'fenced',id};throw error;}
 const run=process.env.CONTINUITY_EFFECTS_ENABLED==='true'&&process.env.CONTINUITY_INSTANCE==='standby'?{runId:'independent:builder:'+id}:active?await deps.start(builderLife,[id],{deploymentId:active.deploymentId}):await deps.start(builderLife,[id]);
 const event=builderDispatchRecord(p,sent);
 await deps.journal(event.kind,event.summary,{visibility:event.visibility,purpose:event.purpose,operation:event.operation,id,runId:run.runId});
 return {state:'queued',id,runId:run.runId,operation:event.operation};
}
export async function builderLife(id:string):Promise<{state:string}>{
 'use workflow';
 for(let n=0;n<24;n++){
  const r=await buildStep(id);
  if(['fenced','disabled','idle_or_busy','blocked','ready_for_review','needs_changes','editing','untested','published'].includes(r.state))return {state:r.state};
  await sleep(['quota_wait','capacity_wait'].includes(r.state)&&r.nextAt?new Date(r.nextAt):new Date(Date.now()+(r.state==='pending'?60000:1000)));
 }
 return {state:'checkpointed'};
}
async function buildStep(id:string){'use step';return builderTick(id);}
buildStep.maxRetries=0;
// Selection and admission share Builder's transaction lock, so two recovery
// calls cannot select one oldest intake and accidentally admit different work.
// Both queues keep their original request IDs; BuilderStore owns all quotas.
export async function drainBuilderQueues(store:BuilderStore,config:any,eligible:typeof feedbackSourceEligible=feedbackSourceEligible):Promise<{status:string;projectId?:string|null}>{
 if(!builderEnabled(config))return {status:'disabled'};
 return store.db.transaction(async q=>{
  await q.query('SELECT pg_advisory_xact_lock(6041010)');
  await store.coordination.assertCurrent(q);
  const tables=(await q.query("SELECT to_regclass('public.claus_site_intake') AS site,to_regclass('public.claus_prototype_intake') AS prototype")).rows[0];
  const scoped:LabDatabase={query:q.query.bind(q),transaction:fn=>fn(q)};
  let deferred=false;
  // Each unavailable row moves beyond the transaction's fixed now(), so it is
  // checked at most once per pass and retried no sooner than five minutes.
  // Do not stop at the daily intake cap: older backlog must not hide eligible
  // work when the recovery interval is longer than the source retry delay.
  for(;;){
  let site:any,prototype:any;
  if(tables.site&&autonomyEnabled(config)&&(await new SiteStore(scoped).current()).enabled){
   site=(await q.query("SELECT i.id,i.created_at,i.next_at,b.brief,b.brief_hash FROM claus_site_intake i JOIN claus_site_briefs b ON b.id=i.brief_id WHERE i.project_id IS NULL AND (i.next_at<=now() OR i.status='waiting_project_quota') AND b.enabled ORDER BY i.created_at,i.id LIMIT 1")).rows[0];
  }
  if(tables.prototype){
   prototype=(await q.query("SELECT id,created_at,next_at,proposal FROM claus_prototype_intake WHERE project_id IS NULL AND (next_at<=now() OR status='waiting_project_quota') AND (runtime='javascript' OR $1::boolean) ORDER BY created_at,id LIMIT 1",[builderRuntimeEnabled(config,'solidity')])).rows[0];
  }
  if(!site&&!prototype)return {status:deferred?'waiting_source_unavailable':'idle'};
  const chooseSite=site&&(!prototype||new Date(site.created_at).getTime()<new Date(prototype.created_at).getTime()||new Date(site.created_at).getTime()===new Date(prototype.created_at).getTime()&&site.id<prototype.id);
  const intake=chooseSite?site:prototype,source=chooseSite?intake.brief.source:intake.proposal.source;
  let available=false;
  try{available=(!chooseSite||hash(intake.brief)===intake.brief_hash)&&(!source&&chooseSite||!!source&&await eligible(source));}catch{/* Source read failure never admits frozen, unverified prose. */}
  if(!available){
   if(chooseSite)await q.query("UPDATE claus_site_intake SET status='waiting_source_unavailable',wait_reason='site_source_unavailable',next_at=now()+interval '5 minutes' WHERE id=$1 AND project_id IS NULL",[intake.id]);
   else await q.query("UPDATE claus_prototype_intake SET status='waiting_source_unavailable',next_at=now()+interval '5 minutes' WHERE id=$1 AND project_id IS NULL",[intake.id]);
   deferred=true;continue;
  }
  return chooseSite?new SiteFeatureStore(scoped).drainQueued():new FeedbackBuildStore(scoped).drainQueued(config);
  }
 });
}
// Cron requests reach the current agent deployment. Queue admission must run
// on the pinned Builder too, not only execution of already-admitted projects.
export async function builderRecoveryLife():Promise<any>{
 'use workflow';
 return builderRecoveryStep();
}
async function builderRecoveryStep(){'use step';return recoverBuilder();}
builderRecoveryStep.maxRetries=0;
async function forwardBuilderRecovery(deploymentId:string){
 const run=await start(builderRecoveryLife,[],{deploymentId});
 return {state:'recovery_queued',runId:run.runId};
}
type RecoveryDependencies={store:BuilderStore;configuration:()=>Promise<any>;start:(id:string)=>Promise<any>;eligible?:typeof feedbackSourceEligible;forward?:(deploymentId:string)=>Promise<any>};
export async function recoverBuilder(deps:RecoveryDependencies={store:builderStore(),configuration,start:startBuilder,forward:forwardBuilderRecovery}){
 const config=await deps.configuration(),sent=await nextBuilderReconciliation(deps.store);
 if(!builderEnabled(config))return sent?deps.start(sent.id):{state:'disabled'};
 // Old disabled work retains its receipt lookup, but cannot take every wake
 // ahead of eligible work once its live execution window has expired.
 // BuilderStore.next still enforces active leases and execution windows.
 try{
 await deps.store.coordination.assertCurrent();
 await deps.store.wakeCapacityWaiters();
 // Resume admitted work before consuming its newly available capacity with
 // another intake. The store still applies source, lease and initial-attempt
 // priority checks; this does not release or replay pending effects.
 const existingEligibility=builderWorkEligible(config,deps.eligible);
 const existing=await deps.store.next(existingEligibility);
 if(existing){const detail=await deps.store.detail(existing.id);if(!sentBuilderEffect(detail)&&await existingEligibility(detail,deps.store.db))return deps.start(existing.id);}
 const admitted=await drainBuilderQueues(deps.store,config,deps.eligible);
 if(admitted.projectId)return deps.start(admitted.projectId);
 const p=await deps.store.next(builderWorkEligible(config,deps.eligible));
 if(p){const detail=await deps.store.detail(p.id);if(sentBuilderEffect(detail)||await workEnabled(deps.store,detail,config))return deps.start(p.id);}
 return sent?deps.start(sent.id):{state:p?'disabled':admitted.status==='idle'?'idle':admitted.status};
 }catch(error){
  if(error instanceof BuilderDeploymentFence){
   const active=error.reason==='stale'&&deps.forward?await deps.store.coordination.active():null;
   if(active)return deps.forward!(active.deploymentId);
   return sent?deps.start(sent.id):{state:'fenced'};
  }
  throw error;
 }
}
export async function readBuilderWithPrototypeQueue<T extends object>(args:any,store:BuilderStore,read:(args:any)=>Promise<T>):Promise<T&{prototypeQueue?:Awaited<ReturnType<FeedbackBuildStore['read']>>['projects']}>{
 const result=await read(args);
 if(args?.id||!(await store.db.query("SELECT to_regclass('public.claus_prototype_intake') AS table_name")).rows[0]?.table_name)return result;
 return {...result,prototypeQueue:(await new FeedbackBuildStore(store.db).read({},'club')).projects};
}
export async function builderTool(requestId:string,name:string,args:any){
 if(!builderEnabled(await configuration()))throw Error('builder_disabled');
 if(name==='read_builder')return readBuilderWithPrototypeQueue(args,builderStore(),readBuilder);
 if(name!=='create_build')throw Error('builder_tool_invalid');
 const runtime=buildRuntime(args.runtime);if(!builderRuntimeEnabled(await configuration(),runtime))throw Error('builder_solidity_disabled');
 const p=await builderStore().create(requestId,args.title,args.goal,'claus','prototype',undefined,runtime);
 return {...await startBuilder(p.id),visibility:'private_club',deployed:false};
}
