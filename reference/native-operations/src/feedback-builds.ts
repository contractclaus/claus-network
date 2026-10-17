import {managedDatabase,managedSchemaReady} from './database-schema.js';
import {BuilderStore} from './builder-store.js';
import {buildRuntime,builderRuntimeEnabled,BUILD_LIMITS,type BuildRuntime} from './builder-schema.js';
import {hash,text} from './lab-schema.js';
import {productionLabDatabase,type LabDatabase,type LabQuery} from './lab-db.js';
import {configuration} from './store.js';
import {resolveFeedbackSource,type FeedbackSource} from './feedback-source.js';

type Channel='public'|'club';
type Proposal={source:FeedbackSource;title:string;goal:string;reason:string;runtime:BuildRuntime};
type QueueResult={status:string;id?:string;requestId?:string;canonicalRequestId?:string;projectId?:string|null;runtime?:BuildRuntime;nextAt?:string;replayed?:boolean;deduplicated?:boolean};
const statuses=new Set(['queued','admitted','waiting_source_unavailable','waiting_builder','waiting_project_quota','waiting_model_quota','waiting_reconciliation','waiting_test_quota','testing','model_pending','test_pending','reconciling','ready_for_review','needs_changes','editing','blocked','untested']);
const safeStatus=(status:unknown)=>typeof status==='string'&&statuses.has(status)?status:'unknown';
function exact(value:any,keys:string[]){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))throw Error('prototype_request_invalid');
}
function prose(value:unknown,max:number,field:string){try{text(value,max);}catch{throw Error('prototype_invalid_'+field+'_nonempty_text_max_'+max);}return value as string;}
function identifier(value:unknown){if(typeof value!=='string'||!/^[A-Za-z0-9_:.-]{1,160}$/.test(value))throw Error('prototype_id_invalid');return value;}
function proposal(value:Proposal):Proposal{
 exact(value,['source','title','goal','reason','runtime']);
 if(value.runtime===undefined)throw Error('prototype_request_invalid');
 const s=value.source;exact(s,['kind','id','authorId','contentHash','visibility','text']);
 if(!['x','club_message','club_idea','self'].includes(s.kind)||!['public','private'].includes(s.visibility)||! /^[a-f0-9]{64}$/.test(s.contentHash))throw Error('prototype_source_invalid');
 if(s.kind==='x'&&s.visibility!=='public'||s.kind.startsWith('club_')&&s.visibility!=='private'||s.kind==='self'&&(s.id!=='initiative'||s.authorId!=='claus'))throw Error('prototype_source_invalid');
 return {title:prose(value.title,120,'title'),goal:prose(value.goal,4000,'goal'),reason:prose(value.reason,1000,'reason'),runtime:buildRuntime(value.runtime),source:{kind:s.kind,id:identifier(s.id),authorId:identifier(s.authorId),visibility:s.visibility,contentHash:s.contentHash,text:prose(s.text,16000,'source')}};
}

// Only the service-resolved source enters this store. Intake does not consume
// a Builder project seat, reserve inference, execute code or publish anything.
export class FeedbackBuildStore{
 constructor(readonly db:LabDatabase){}
 async availability(){
  const usage=await new BuilderStore(this.db).usage('claus');
  if(usage.sharedDailyModelRequestsRemaining!==null&&usage.sharedDailyModelRequestsRemaining<1){
   const held=BigInt(usage.sharedPendingModelMicroUsdc);
   const waitsForReceipt=BigInt(usage.sharedDailyModelBudgetMicroUsdc ?? BUILD_LIMITS.dailyModelBudget)-held<BigInt(BUILD_LIMITS.modelReservation);
   return {state:waitsForReceipt?'waiting_for_reconciliation':'waiting_model_quota',nextCheckAt:waitsForReceipt?null:usage.resetsAt,meaning:waitsForReceipt?'Unresolved model requests occupy the existing allowance. A day change alone does not restore capacity. Saved requests have not started.':'The daily model allowance is occupied. This is a recheck time, not a promised start.'};
  }
  return {state:'capacity_available',nextCheckAt:null,meaning:'Local quota permits admission; worker availability and provider checks still apply. This does not mean a saved request is running.'};
 }
 async initialize(){if(managedDatabase())return managedSchemaReady();await this.db.query(`
 CREATE TABLE IF NOT EXISTS claus_prototype_intake(id text PRIMARY KEY,request_id text UNIQUE NOT NULL,dedupe_hash text UNIQUE NOT NULL,proposal jsonb NOT NULL,source_author text NOT NULL,visibility text NOT NULL CHECK(visibility IN ('public','private')),runtime text NOT NULL CHECK(runtime IN ('javascript','solidity')),project_request_id text UNIQUE NOT NULL,project_id text UNIQUE REFERENCES claus_builds(id),status text NOT NULL DEFAULT 'queued',next_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS claus_prototype_requests(id text PRIMARY KEY,input_hash text NOT NULL,intake_id text NOT NULL REFERENCES claus_prototype_intake(id),created_at timestamptz NOT NULL DEFAULT now());
 CREATE INDEX IF NOT EXISTS claus_prototype_intake_queue ON claus_prototype_intake(created_at,id) WHERE project_id IS NULL;
 `);}
 async propose(requestId:string,value:Proposal):Promise<QueueResult>{
  if(!/^[A-Za-z0-9:_-]{1,160}$/.test(requestId))throw Error('prototype_request_invalid');
  const p=proposal(value),inputHash=hash(p),key=hash({kind:p.source.kind,id:p.source.id,visibility:p.source.visibility,...(p.source.kind==='self'?{goal:p.goal,runtime:p.runtime}:{})});
  return this.db.transaction(async q=>{
   await q.query('SELECT pg_advisory_xact_lock(6041013)');
   const old=(await q.query('SELECT * FROM claus_prototype_requests WHERE id=$1',[requestId])).rows[0];
   if(old){if(old.input_hash!==inputHash)throw Error('prototype_request_conflict');return {...await this.result(q,old.intake_id),requestId,replayed:true,deduplicated:false};}
   let intake=(await q.query('SELECT * FROM claus_prototype_intake WHERE dedupe_hash=$1',[key])).rows[0];
   const deduplicated=!!intake;
   if(intake){if(intake.proposal.source.contentHash!==p.source.contentHash||intake.source_author!==p.source.authorId)throw Error('prototype_source_conflict');}
   else{
    const count=(await q.query("SELECT count(*) FILTER(WHERE proposal->'source'->>'kind'<>'self')::int AS total,count(*) FILTER(WHERE source_author=$1)::int AS author FROM claus_prototype_intake WHERE created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",[p.source.authorId])).rows[0];
    // Native self-directed work uses actual Builder budget and execution capacity.
    // Keep community intake limits and source-bound deduplication unchanged.
    if(p.source.kind!=='self'&&count.author>=1)throw Error('prototype_author_daily_limit');
    if(p.source.kind!=='self'&&count.total>=12)throw Error('prototype_daily_intake_limit');
    intake=(await q.query('INSERT INTO claus_prototype_intake(id,request_id,dedupe_hash,proposal,source_author,visibility,runtime,project_request_id) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8) RETURNING *',['prototype:'+key,requestId,key,JSON.stringify(p),p.source.authorId,p.source.visibility,p.runtime,'prototype-queue:'+key])).rows[0];
   }
   await q.query('INSERT INTO claus_prototype_requests(id,input_hash,intake_id) VALUES($1,$2,$3)',[requestId,inputHash,intake.id]);
   return {...await this.result(q,intake.id),requestId,replayed:false,deduplicated};
  });
 }
 private async result(q:LabQuery,id:string):Promise<QueueResult>{
  const i=(await q.query('SELECT i.*,p.status AS project_status,p.next_at AS project_next_at FROM claus_prototype_intake i LEFT JOIN claus_builds p ON p.id=i.project_id WHERE i.id=$1',[id])).rows[0];
  if(!i)throw Error('prototype_request_missing');
  return {id:i.id,status:safeStatus(i.project_status??i.status),canonicalRequestId:i.request_id,projectId:i.project_id??null,runtime:i.runtime,nextAt:new Date(i.project_next_at??i.next_at).toISOString()};
 }
 async drainQueued(config:any):Promise<QueueResult>{
  if(!builderRuntimeEnabled(config,'javascript'))return {status:'disabled'};
  return this.db.transaction(async q=>{
   await q.query('SELECT pg_advisory_xact_lock(6041010)');
   const i=(await q.query("SELECT * FROM claus_prototype_intake WHERE project_id IS NULL AND (next_at<=now() OR status='waiting_project_quota') AND (runtime='javascript' OR $1::boolean) ORDER BY created_at,id LIMIT 1 FOR UPDATE",[builderRuntimeEnabled(config,'solidity')])).rows[0];
   if(!i)return {status:'idle'};
   const scoped:LabDatabase={query:q.query.bind(q),transaction:fn=>fn(q)},builds=new BuilderStore(scoped),usage=await builds.usage('claus');
   const wait=async(status:string,nextAt:string)=>{await q.query('UPDATE claus_prototype_intake SET status=$2,next_at=$3 WHERE id=$1',[i.id,status,nextAt]);return this.result(q,i.id);};
   if(usage.sharedDailyModelRequestsRemaining!==null&&usage.sharedDailyModelRequestsRemaining<1){
    if(BigInt(usage.sharedDailyModelBudgetMicroUsdc ?? BUILD_LIMITS.dailyModelBudget)-BigInt(usage.sharedPendingModelMicroUsdc)<BigInt(BUILD_LIMITS.modelReservation))return wait('waiting_reconciliation',new Date(Date.now()+300000).toISOString());
    return wait('waiting_model_quota',usage.resetsAt);
   }
   if((await q.query('SELECT id FROM claus_builds WHERE lease_until>now() LIMIT 1')).rows.length)return wait('waiting_builder',new Date(Date.now()+60000).toISOString());
   const p=await builds.create(i.project_request_id,i.proposal.title,i.proposal.goal,'claus','prototype',undefined,i.runtime);
   await q.query("UPDATE claus_prototype_intake SET project_id=$2,status='admitted',next_at=now() WHERE id=$1",[i.id,p.id]);
   return {...await this.result(q,i.id),status:'admitted'};
  });
 }
 // Existing private Builder projects have no row in this queue. A project ID
 // supplied on X cannot turn the private Builder reader into a public reader.
 async read(args:any={},channel:Channel='public'){
  if(!['public','club'].includes(channel)||!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>k!=='id'))throw Error('prototype_read_invalid');
  const id=args.id===undefined?null:identifier(args.id);
  const rows=(await this.db.query(`SELECT i.*,p.status AS project_status,p.next_at AS project_next_at,p.revision
   FROM claus_prototype_intake i LEFT JOIN claus_builds p ON p.id=i.project_id
   WHERE ($1::text IS NULL OR i.id=$1 OR i.project_id=$1 OR EXISTS(SELECT 1 FROM claus_prototype_requests r WHERE r.intake_id=i.id AND r.id=$1))
   AND ($2::boolean OR i.visibility='public') AND (p.id IS NULL OR p.owner_scope='claus' AND p.purpose='prototype' AND p.runtime=i.runtime)
   ORDER BY i.created_at DESC,i.id LIMIT 24`,[id,channel==='club'])).rows;
  if(id&&!rows.length)throw Error('prototype_request_missing');
  const projects=[];
  for(const i of rows){
   const version=i.project_id?(await this.db.query('SELECT source_hash FROM claus_build_versions WHERE project_id=$1 AND revision=$2',[i.project_id,i.revision])).rows[0]:null;
   const test=i.project_id?(await this.db.query("SELECT status,output FROM claus_build_effects WHERE project_id=$1 AND revision=$2 AND kind='test' ORDER BY created_at DESC,id DESC LIMIT 1",[i.project_id,i.revision])).rows[0]:null;
   projects.push({id:i.id,canonicalRequestId:i.request_id,projectId:i.project_id??null,runtime:i.runtime,status:safeStatus(i.project_status??i.status),nextAt:new Date(i.project_next_at??i.next_at).toISOString(),feedbackHash:i.proposal.source.contentHash,sourceHash:version?.source_hash??null,testStatus:test&&['reserved','running','uncertain','completed','failed'].includes(test.status)?test.status:null,testHash:test?.status==='completed'?hash(test.output):null,ownerReviewRequired:true,published:false,deployed:false,
    ...(channel==='club'?{visibility:i.visibility,title:i.proposal.title,goal:i.proposal.goal,reason:i.proposal.reason}:{})});
  }
  return {visibility:channel==='club'?'private_club':'public',availability:await this.availability(),projects};
 }
 async project(id:string):Promise<Proposal|null>{
  if(!(await this.db.query("SELECT to_regclass('public.claus_prototype_intake') AS table_name")).rows[0]?.table_name)return null;
  const i=(await this.db.query('SELECT proposal FROM claus_prototype_intake WHERE project_id=$1',[id])).rows[0];return i?proposal(i.proposal):null;
 }
 async requestSource(id:string):Promise<FeedbackSource|null>{
  const i=(await this.db.query('SELECT i.proposal FROM claus_prototype_requests r JOIN claus_prototype_intake i ON i.id=r.intake_id WHERE r.id=$1',[id])).rows[0];
  return i?proposal(i.proposal).source:null;
 }
}

let instance:FeedbackBuildStore|undefined;
export const feedbackBuildStore=()=>instance??=new FeedbackBuildStore(productionLabDatabase());
export const feedbackBuildTools=new Set(['propose_prototype','read_prototype']);
const s={type:'string'};
export const feedbackBuildDefinitions=[
 {type:'function',function:{name:'propose_prototype',description:'Save a reasoned offline Solidity or JavaScript prototype request after judging an actual X post, Club message/idea, or self/initiative. Explain benefit and tradeoffs in reason. Source attribution and privacy come from service records. Your own initiative is admitted using actual Builder budget and capacity; community-source intake limits remain. The durable intake queue uses existing Builder model and test quotas. Queued work is not completed work. Generated code requires owner review; no public source, package publication, wallet, network or mainnet execution. Use read_prototype for sanitized status; Club may inspect admitted source privately with read_builder.',parameters:{type:'object',properties:{sourceKind:{type:'string',enum:['x','club_message','club_idea','self']},sourceId:s,title:{type:'string',minLength:1,maxLength:120},goal:{type:'string',minLength:1,maxLength:4000},reason:{type:'string',minLength:1,maxLength:1000},runtime:{type:'string',enum:['solidity','javascript']}},required:['sourceKind','sourceId','title','goal','reason','runtime'],additionalProperties:false}}},
 {type:'function',function:{name:'read_prototype',description:'Read durable prototype intake and actual Builder status. Optional id selects a returned queue, request or project ID. Public reads include only public-source requests created through this queue, sanitized status and recorded feedback/source/test hashes. Files, generated prose, private projects and test logs stay private. A recorded status is not an audit or deployment.',parameters:{type:'object',properties:{id:s},required:[],additionalProperties:false}}}
];
type ServiceDependencies={store:()=>FeedbackBuildStore;config:()=>Promise<any>;resolve:typeof resolveFeedbackSource;wake:()=>Promise<unknown>};
export function feedbackBuildService(deps:ServiceDependencies){return async(id:string,name:string,args:any,channel:Channel)=>{
 if(!['public','club'].includes(channel))throw Error('prototype_channel_invalid');
 if(name==='read_prototype')return deps.store().read(args,channel);
 if(name!=='propose_prototype')throw Error('prototype_tool_invalid');
 exact(args,['sourceKind','sourceId','title','goal','reason','runtime']);
 if(args.runtime===undefined)throw Error('prototype_request_invalid');
 const runtime=buildRuntime(args.runtime);
 if(!builderRuntimeEnabled(await deps.config(),runtime))throw Error('builder_disabled');
 const original=await deps.store().requestSource(id);
 if(original&&(original.kind!==args.sourceKind||original.id!==args.sourceId))throw Error('prototype_request_conflict');
 const source=original??await deps.resolve(args.sourceKind,args.sourceId,channel);
 if(channel==='public'&&source.visibility!=='public'||channel==='club'&&source.visibility!=='private')throw Error('prototype_channel_mismatch');
 const result=await deps.store().propose(id,{source,title:args.title,goal:args.goal,reason:args.reason,runtime});
 await deps.wake().catch(()=>null); // A failed wake never loses accepted intake.
 return {...result,availability:await deps.store().availability(),ownerReviewRequired:true,published:false,deployed:false};
};}
export async function feedbackBuildTool(id:string,name:string,args:any,channel:Channel){
 return feedbackBuildService({store:feedbackBuildStore,config:configuration,resolve:resolveFeedbackSource,wake:async()=>{const {recoverBuilder}=await import('./builder-life.js');return recoverBuilder();}})(id,name,args,channel);
}
