import {managedDatabase,managedSchemaReady} from './database-schema.js';
import type {LabDatabase,LabQuery} from './lab-db.js';
import {modelCapacity} from './builder-wait.js';
import {hash,text} from './lab-schema.js';
import {builderCommitment} from './builder-preflight.js';
import {BUILD_LIMITS,buildHash,buildFiles,buildRuntime,builderRuntimeEnabled,type BuildFile} from './builder-schema.js';
import {BuilderCoordination} from './builder-coordination.js';
export type BuilderEligibility=(project:any,q:LabQuery)=>Promise<boolean>;
export function builderWorkEligible(config:any,eligible?:(source:any)=>Promise<boolean>):BuilderEligibility{
 const checked=new Map<string,Promise<boolean>>();
 const sourceAllowed=(source:any)=>{
  if(!source)return Promise.resolve(true);
  const key=hash(source);if(!checked.has(key))checked.set(key,(async()=>{
   try{return await (eligible??(async s=>(await import('./feedback-source.js')).feedbackSourceEligible(s)))(source);}catch{return false;}
  })());return checked.get(key)!;
 };
 return async(p,q)=>{
  if(!builderRuntimeEnabled(config,buildRuntime(p.runtime)))return false;
  if(p.purpose==='operations'){
   if(!config.settings.networkOperations?.enabled||!config.policy.capabilities.networkBuild)return false;
   const r=(await q.query('SELECT c.enabled,c.scope FROM claus_operations_releases r JOIN claus_operations_control c ON c.scope=r.scope WHERE r.build_id=$1',[p.id])).rows[0];return r?.enabled===true&&!!process.env.PUBLISHER_SECRET;
  }
  if(p.purpose==='surface'){
   if(!config.settings.networkOperations?.enabled||!config.policy.capabilities.networkBuild)return false;
   const row=(await q.query('SELECT enabled FROM claus_surface_control WHERE id')).rows[0];return row?.enabled===true;
  }
  if(p.purpose!=='site'){
   if(!(await q.query("SELECT to_regclass('public.claus_prototype_intake') AS intake")).rows[0]?.intake)return true;
   const row=(await q.query('SELECT proposal FROM claus_prototype_intake WHERE project_id=$1',[p.id])).rows[0];
   return sourceAllowed(row?.proposal?.source);
  }
  if(config.settings.siteEditor?.enabled!==true||config.settings.siteEditor?.autonomyEnabled!==true)return false;
  const tables=(await q.query("SELECT to_regclass('public.claus_site_jobs') AS jobs,to_regclass('public.claus_site_control') AS control")).rows[0];
  if(!tables?.jobs||!tables?.control)return false;
  const row=(await q.query(`SELECT b.enabled,b.brief,b.brief_hash,j.brief_hash AS frozen_hash,c.enabled AS site_enabled
   FROM claus_site_jobs j JOIN claus_site_briefs b ON b.id=j.brief_id CROSS JOIN claus_site_control c WHERE j.project_id=$1 AND c.id`,[p.id])).rows[0];
  return row?.enabled===true&&row.site_enabled===true&&row.brief_hash===row.frozen_hash&&hash(row.brief)===row.brief_hash&&await sourceAllowed(row.brief.source);
 };
}
export class BuilderQuotaWait extends Error {
 constructor(readonly kind:'model'|'test',readonly resetAt:string,readonly capacity?:ReturnType<typeof modelCapacity>){super(capacity?.reason==='unresolved_reservations'?'builder_unresolved_reservations':`builder_daily_${kind}_budget`);}
 get nextCheckAt(){return this.capacity?.nextCheckAt??this.resetAt;}
}
const activeEffects="('reserved','running','uncertain')";
const runnable="('queued','testing','model_pending','test_pending','reconciling','waiting_model_quota','waiting_test_quota')";
// Apply priority in both discovery and targeted claims; a per-project workflow
// cannot bypass another project's first model attempt.
const initialAttempt=(alias:string)=>`${alias}.status IN ('queued','waiting_model_quota') AND ${alias}.next_at<=now() AND NOT EXISTS(SELECT 1 FROM claus_build_effects i WHERE i.project_id=${alias}.id AND i.kind='model')`;
const claimable=`b.status IN ${runnable} AND b.next_at<=now() AND b.id=ANY($2::text[]) AND
 NOT EXISTS(SELECT 1 FROM claus_build_effects live WHERE live.project_id<>b.id AND live.status IN ${activeEffects}
 AND COALESCE((live.progress->>'activeUntil')::timestamptz,live.created_at+CASE WHEN live.kind='model' THEN interval '15 minutes' ELSE interval '3 minutes' END)>now()) AND
 (b.status NOT IN ('queued','waiting_model_quota') OR EXISTS(SELECT 1 FROM claus_build_effects pending WHERE pending.project_id=b.id AND pending.status IN ${activeEffects}) OR NOT EXISTS(SELECT 1 FROM claus_build_effects m WHERE m.project_id=b.id AND m.kind='model') OR
 NOT EXISTS(SELECT 1 FROM claus_builds first WHERE ${initialAttempt('first')} AND first.id=ANY($2::text[])))`;
const priority=`CASE WHEN ${initialAttempt('b')} THEN 0 ELSE 1 END,b.next_at,b.created_at,b.id`;
export class BuilderStore {
 constructor(readonly db:LabDatabase,readonly coordination=new BuilderCoordination(db)){}
 async initialize(){if(managedDatabase())return managedSchemaReady();await this.db.query(`
 CREATE TABLE IF NOT EXISTS claus_builds(id text PRIMARY KEY,title text NOT NULL,goal text NOT NULL,status text NOT NULL DEFAULT 'queued',revision integer NOT NULL DEFAULT 0,summary text NOT NULL DEFAULT '',lease_owner text,lease_until timestamptz,next_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS claus_build_effects(id text PRIMARY KEY,project_id text NOT NULL REFERENCES claus_builds(id),revision integer NOT NULL,kind text NOT NULL,status text NOT NULL DEFAULT 'reserved',input jsonb NOT NULL,output jsonb,progress jsonb,amount bigint NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS claus_build_versions(project_id text NOT NULL REFERENCES claus_builds(id),revision integer NOT NULL,source_effect text UNIQUE NOT NULL REFERENCES claus_build_effects(id),files jsonb NOT NULL,source_hash text NOT NULL,summary text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(project_id,revision));
 ALTER TABLE claus_builds ADD COLUMN IF NOT EXISTS owner_scope text NOT NULL DEFAULT 'claus';
 ALTER TABLE claus_builds ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'prototype';
 ALTER TABLE claus_builds ADD COLUMN IF NOT EXISTS runtime text NOT NULL DEFAULT 'javascript' CHECK(runtime IN ('javascript','solidity'));
 ALTER TABLE claus_builds ADD COLUMN IF NOT EXISTS initial_mode text NOT NULL DEFAULT 'prototype';
 ALTER TABLE claus_builds ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'prototype' CHECK(purpose IN ('prototype','site'));
 ALTER TABLE claus_builds DROP CONSTRAINT IF EXISTS claus_builds_purpose_check;
 ALTER TABLE claus_builds ADD CONSTRAINT claus_builds_purpose_check CHECK(purpose IN ('prototype','site','surface','operations'));
 ALTER TABLE claus_build_versions ALTER COLUMN source_effect DROP NOT NULL;
 CREATE TABLE IF NOT EXISTS claus_build_requests(id text PRIMARY KEY,owner_scope text NOT NULL,input_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 ALTER TABLE claus_build_effects ADD COLUMN IF NOT EXISTS application_status text;
 ALTER TABLE claus_build_effects ADD COLUMN IF NOT EXISTS application_reason text;
 ALTER TABLE claus_build_effects ADD COLUMN IF NOT EXISTS application_at timestamptz;
 CREATE INDEX IF NOT EXISTS claus_build_owner ON claus_builds(owner_scope,created_at);
 CREATE TABLE IF NOT EXISTS claus_build_seats(day date NOT NULL,seat text NOT NULL,project_id text NOT NULL REFERENCES claus_builds(id),PRIMARY KEY(day,seat));
 `);}
 async create(requestId:string,title:string,goal:string,ownerScope='claus',mode='prototype',seatCandidates?:string[],runtime:unknown='javascript',purpose='prototype',siteInit?:{prepare(q:LabQuery):Promise<void>;save(q:LabQuery,id:string):Promise<void>}){
  if(!['prototype','site','surface','operations'].includes(purpose)||['site','surface','operations'].includes(purpose)&&(ownerScope!=='claus'||mode!=='source'||runtime!=='javascript'||!siteInit)||!['site','surface','operations'].includes(purpose)&&siteInit)throw Error('builder_purpose_invalid');
  runtime=buildRuntime(runtime);this.owner(ownerScope);if(!['prototype','source'].includes(mode)||! /^[A-Za-z0-9:_-]{1,160}$/.test(requestId))throw Error('builder_request_invalid');
  title=text(title,120);goal=text(goal,4000);const id='build_'+hash(ownerScope==='claus'?requestId:ownerScope+':'+requestId).slice(0,24);
  return this.db.transaction(async q=>{
   await q.query('SELECT pg_advisory_xact_lock(6041010)');
   const old=(await q.query('SELECT * FROM claus_builds WHERE id=$1',[id])).rows[0];
   if(old){if(old.title!==title||old.goal!==goal||old.owner_scope!==ownerScope||old.initial_mode!==mode||old.runtime!==runtime||old.purpose!==purpose)throw Error('builder_request_conflict');return old;}
   if(siteInit)await siteInit.prepare(q);
   if(ownerScope!=='claus'){
    const [{n:count}]=(await q.query("SELECT count(*)::int n FROM claus_builds WHERE owner_scope=$1 AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",[ownerScope])).rows;
    if(count>=1)throw Error('builder_member_daily_limit');
   }
   let seat:string|undefined;
   if(seatCandidates!==undefined){
    if(ownerScope==='claus'||!Array.isArray(seatCandidates)||!seatCandidates.length||seatCandidates.length>300||seatCandidates.some(s=>!/^nft:(?:[1-9]|[1-9][0-9]|[12][0-9]{2}|300)$/.test(s)&&!(s==='admin:0xbb145ca83272c3806d4ddc75ca1d5514789cf1c5'&&ownerScope==='member:0xbb145ca83272c3806d4ddc75ca1d5514789cf1c5')))throw Error('builder_entitlement_invalid');
    const used=new Set((await q.query("SELECT seat FROM claus_build_seats WHERE day=(now() AT TIME ZONE 'UTC')::date")).rows.map(r=>r.seat));
    seat=seatCandidates.find(s=>!used.has(s));if(!seat)throw Error('builder_nft_daily_limit');
   }
   const created=(await q.query('INSERT INTO claus_builds(id,title,goal,owner_scope,mode,status,initial_mode,runtime,purpose) VALUES($1,$2,$3,$4,$5,$6,$5,$7,$8) RETURNING *',[id,title,goal,ownerScope,mode,mode==='source'?'editing':'queued',runtime,purpose])).rows[0];
   if(siteInit)await siteInit.save(q,created.id);
   if(seat)await q.query("INSERT INTO claus_build_seats(day,seat,project_id) VALUES((now() AT TIME ZONE 'UTC')::date,$1,$2)",[seat,id]);return created;
  });
 }
 async detail(id:string){
  const p=(await this.db.query('SELECT * FROM claus_builds WHERE id=$1',[id])).rows[0];if(!p)throw Error('builder_project_missing');
  const versions=(await this.db.query('SELECT * FROM claus_build_versions WHERE project_id=$1 ORDER BY revision DESC',[id])).rows;
  const effects=(await this.db.query('SELECT * FROM claus_build_effects WHERE project_id=$1 ORDER BY created_at,id',[id])).rows;
  return {...p,versions,effects};
 }
 async list(ownerScope='claus'){this.owner(ownerScope);return (await this.db.query('SELECT id,title,status,revision,summary,mode,runtime,created_at,updated_at FROM claus_builds WHERE owner_scope=$1 ORDER BY created_at DESC LIMIT 24',[ownerScope])).rows;}
 owner(scope:string){if(scope!=='claus'&&!/^member:0x[0-9a-f]{40}$/.test(scope))throw Error('builder_owner_invalid');}
 async ownedDetail(id:string,scope:string){this.owner(scope);const p=await this.detail(id);if(p.owner_scope!==scope)throw Error('builder_project_missing');return p;}
 async usage(scope:string){
  this.owner(scope);
  return this.db.transaction(async q=>{
   await q.query('SELECT pg_advisory_xact_lock(6041010)');
   const clock=(await q.query("SELECT (date_trunc('day',now() AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC' AS reset_at")).rows[0];
   const projects=(await q.query("SELECT id,owner_scope FROM claus_builds WHERE created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'")).rows;
   const effects=(await q.query(`SELECT e.id,e.output,e.project_id,e.kind,e.amount::text,e.status,b.owner_scope,
    e.created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS today
    FROM claus_build_effects e JOIN claus_builds b ON b.id=e.project_id
    WHERE b.owner_scope=$1 OR e.created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' OR e.status IN ${activeEffects}`,[scope])).rows;
   const daily=effects.filter(e=>e.today||['reserved','running','uncertain'].includes(e.status));
   const modelUsed=daily.filter(e=>e.kind==='model').reduce((n,e)=>n+builderCommitment(e),0n),testsUsed=daily.filter(e=>e.kind==='test').length;
   const capacity=modelCapacity(effects,new Date(clock.reset_at).toISOString());
   const own=(await q.query('SELECT id,status,next_at FROM claus_builds WHERE owner_scope=$1 ORDER BY created_at DESC LIMIT 24',[scope])).rows;
   const versions=(await q.query('SELECT v.project_id,count(*)::int n FROM claus_build_versions v JOIN claus_builds b ON b.id=v.project_id WHERE b.owner_scope=$1 GROUP BY v.project_id',[scope])).rows;
   const projectsUsed=projects.filter(p=>p.owner_scope===scope).length,projectsPerDay=scope==='claus'?null:1;
   // Null means no count cap; model spending and execution capacity still govern work.
   return {projectsUsed,projectsPerDay,projectsRemaining:projectsPerDay===null?null:Math.max(0,projectsPerDay-projectsUsed),
    sharedDailyProjectsRemaining:null,projectAdmission:'budget_and_capacity',
    sharedDailyModelBudgetMicroUsdc:BUILD_LIMITS.dailyModelBudget,sharedPendingModelMicroUsdc:String(daily.filter(e=>e.kind==='model'&&['reserved','running','uncertain'].includes(e.status)).reduce((n,e)=>n+builderCommitment(e),0n)),sharedDailyModelUsedMicroUsdc:String(modelUsed),sharedDailyModelRemainingMicroUsdc:String(BigInt(BUILD_LIMITS.dailyModelBudget)>modelUsed?BigInt(BUILD_LIMITS.dailyModelBudget)-modelUsed:0n),sharedDailyModelRequestsRemaining:Number((BigInt(BUILD_LIMITS.dailyModelBudget)>modelUsed?BigInt(BUILD_LIMITS.dailyModelBudget)-modelUsed:0n)/BigInt(BUILD_LIMITS.modelReservation)),
    sharedDailyTestRuns:BUILD_LIMITS.dailyTestRuns,sharedDailyTestRunsUsed:testsUsed,sharedDailyTestRunsRemaining:Math.max(0,BUILD_LIMITS.dailyTestRuns-testsUsed),
    resetsAt:new Date(clock.reset_at).toISOString(),pendingReservationsCarryOver:true,modelCapacity:capacity,
    projects:own.map(p=>{const es=effects.filter(e=>e.project_id===p.id),models=es.filter(e=>e.kind==='model'),tests=es.filter(e=>e.kind==='test'),used=models.reduce((n,e)=>n+builderCommitment(e),0n);return {id:p.id,status:p.status,waitingReason:p.status==='waiting_model_quota'?capacity.reason:p.status.startsWith('waiting_')?p.status:p.status==='reconciling'?'ambiguous_effect':null,nextEligibleAt:p.status==='waiting_model_quota'?capacity.eligibleAt:p.status==='reconciling'?null:new Date(p.next_at).toISOString(),nextCheckAt:p.status==='waiting_model_quota'?capacity.nextCheckAt:new Date(p.next_at).toISOString(),modelRequestsRemaining:Math.max(0,BUILD_LIMITS.modelRequests-models.length),modelBudgetRemainingMicroUsdc:String(BigInt(BUILD_LIMITS.modelBudget)>used?BigInt(BUILD_LIMITS.modelBudget)-used:0n),testRunsRemaining:Math.max(0,BUILD_LIMITS.testRuns-tests.length),versionsRemaining:Math.max(0,BUILD_LIMITS.versions-(versions.find(v=>v.project_id===p.id)?.n??0)),lifetimeResetsAt:null};})};
  });
 }
 async upload(requestId:string,id:string,scope:string,expectedRevision:number,input:unknown){
  this.owner(scope);
  if(!/^[A-Za-z0-9:_-]{1,120}$/.test(requestId)||!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw Error('builder_request_invalid');
  const key=hash(scope+':upload:'+requestId);
  return this.db.transaction(async q=>{
   await q.query('SELECT pg_advisory_xact_lock(6041010)');
   const p=(await q.query('SELECT * FROM claus_builds WHERE id=$1 AND owner_scope=$2 FOR UPDATE',[id,scope])).rows[0];if(!p)throw Error('builder_project_missing');
   if(['site','surface','operations'].includes(p.purpose))throw Error('builder_site_source_immutable');
   const files=buildFiles(input,buildRuntime(p.runtime)),sourceHash=buildHash(files),inputHash=hash({id,expectedRevision,sourceHash});
   const old=(await q.query('SELECT * FROM claus_build_requests WHERE id=$1',[key])).rows[0];if(old){if(old.input_hash!==inputHash||old.owner_scope!==scope)throw Error('builder_request_conflict');return old.result;}
   if(p.revision!==expectedRevision)throw Error('builder_revision_conflict');
   if(p.lease_until&&new Date(p.lease_until)>new Date()||!['editing','ready_for_review','needs_changes','blocked','untested','waiting_test_quota'].includes(p.status))throw Error('builder_project_busy');
   if((await q.query("SELECT 1 FROM claus_build_effects WHERE project_id=$1 AND status IN ('reserved','running','uncertain')",[id])).rows.length)throw Error('builder_pending_effect');
   const [{n}]=(await q.query('SELECT count(*)::int n FROM claus_build_versions WHERE project_id=$1',[id])).rows;if(n>=BUILD_LIMITS.versions)throw Error('builder_version_limit');
   const [{n:tests}]=(await q.query("SELECT count(*)::int n FROM claus_build_effects WHERE project_id=$1 AND kind='test'",[id])).rows;
   const status=tests>=BUILD_LIMITS.testRuns?'untested':'testing',summary=status==='untested'?'Source saved and exportable, untested: project lifetime test allowance exhausted.':'Source saved. Checks queued.';
   const revision=p.revision+1,result={id,revision,sourceHash,state:status,testRunsRemaining:Math.max(0,BUILD_LIMITS.testRuns-tests)};
   await q.query("UPDATE claus_build_effects SET application_status='superseded',application_reason='Member saved a replacement revision.',application_at=now() WHERE project_id=$1 AND kind='model' AND status='completed' AND application_status IS NULL AND NOT EXISTS(SELECT 1 FROM claus_build_versions v WHERE v.source_effect=claus_build_effects.id)",[id]);
   await q.query('INSERT INTO claus_build_versions(project_id,revision,source_effect,files,source_hash,summary) VALUES($1,$2,NULL,$3::jsonb,$4,$5)',[id,revision,JSON.stringify(files),sourceHash,summary]);
   await q.query("UPDATE claus_builds SET revision=$2,mode='source',status=$3,summary=$4,next_at=now(),updated_at=now() WHERE id=$1",[id,revision,status,summary]);
   await q.query('INSERT INTO claus_build_requests(id,owner_scope,input_hash,result) VALUES($1,$2,$3,$4::jsonb)',[key,scope,inputHash,JSON.stringify(result)]);return result;
  });
 }
 async wakeCapacityWaiters(){return this.db.transaction(async q=>{
  await q.query('SELECT pg_advisory_xact_lock(6041010)');await this.coordination.assertCurrent(q);
  const waiters=(await q.query("SELECT id FROM claus_builds WHERE status='waiting_model_quota' AND (lease_until IS NULL OR lease_until<=now()) LIMIT 1")).rows;
  if(!waiters.length)return;
  const rows=(await q.query("SELECT id,kind,status,amount::text,output,created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS today FROM claus_build_effects WHERE kind='model' AND (created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' OR status IN ('reserved','running','uncertain'))")).rows;
  if(modelCapacity(rows,new Date().toISOString()).ready)await q.query("UPDATE claus_builds SET next_at=LEAST(next_at,now()) WHERE status='waiting_model_quota' AND (lease_until IS NULL OR lease_until<=now())");
 });}
 private async eligibleIds(q:LabQuery,eligible?:BuilderEligibility){
  const rows=(await q.query(`SELECT * FROM claus_builds WHERE status IN ${runnable} AND next_at<=now()`)).rows,ids:string[]=[];
  for(const p of rows)if(!eligible||await eligible(p,q))ids.push(p.id);
  return ids;
 }
 async next(eligible?:BuilderEligibility){return this.db.transaction(async q=>{
  await this.coordination.assertCurrent(q);
  const ids=await this.eligibleIds(q,eligible);
  return (await q.query(`SELECT b.id FROM claus_builds b WHERE ${claimable} AND ($1::text IS NULL OR b.id=$1) AND NOT EXISTS(SELECT 1 FROM claus_builds a WHERE a.lease_until>now()) ORDER BY ${priority} LIMIT 1`,[null,ids])).rows[0];
 });}
 async claim(owner:string,id?:string,eligible?:BuilderEligibility){return this.db.transaction(async q=>{
  await q.query('SELECT pg_advisory_xact_lock(6041010)');
  await this.coordination.assertCurrent(q);
  if((await q.query('SELECT id FROM claus_builds WHERE lease_until>now()')).rows.length)return null;
  const row=(await q.query(`SELECT b.id FROM claus_builds b WHERE ${claimable} AND ($1::text IS NULL OR b.id=$1) ORDER BY ${priority} LIMIT 1`,[id??null,await this.eligibleIds(q,eligible)])).rows[0];
  if(!row)return null;
  return (await q.query("UPDATE claus_builds SET lease_owner=$2,lease_until=now()+interval '12 minutes',updated_at=now() WHERE id=$1 RETURNING *",[row.id,owner])).rows[0];
 });}
 private async owned(q:LabQuery,id:string,owner:string){
  const p=(await q.query('SELECT * FROM claus_builds WHERE id=$1 AND lease_owner=$2 AND lease_until>now() FOR UPDATE',[id,owner])).rows[0];
  if(!p)throw Error('builder_lease_lost');return p;
 }
 async reserve(id:string,owner:string,kind:'model'|'test',input:unknown,eligible?:BuilderEligibility){return this.db.transaction(async q=>{
  await q.query('SELECT pg_advisory_xact_lock(6041010)');const p=await this.owned(q,id,owner);
  await this.coordination.assertCurrent(q);
  if(eligible&&!await eligible(p,q))throw Error('builder_disabled');
  const existing=(await q.query("SELECT * FROM claus_build_effects WHERE project_id=$1 AND status IN ('reserved','running','uncertain')",[id])).rows;
  if(existing.length)throw Error('builder_pending_effect');
  const rows=(await q.query("SELECT id,output,project_id,kind,status,amount::text,created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS today FROM claus_build_effects WHERE project_id=$1 OR created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' OR status IN ('reserved','running','uncertain')",[id])).rows;
  const own=rows.filter(r=>r.project_id===id&&r.kind===kind),daily=rows.filter(r=>r.kind===kind&&(r.today||['reserved','running','uncertain'].includes(r.status)));
  const amount=kind==='model'?BUILD_LIMITS.modelReservation:'0';
  if(kind==='model'&&(own.length>=BUILD_LIMITS.modelRequests||own.reduce((n,r)=>n+builderCommitment(r),0n)+BigInt(amount)>BigInt(BUILD_LIMITS.modelBudget)))throw Error('builder_lifetime_model_budget');
  if(kind==='test'&&own.length>=BUILD_LIMITS.testRuns)throw Error('builder_lifetime_test_budget');
  if(kind==='model'&&own.length){
   const firsts=(await q.query(`SELECT first.* FROM claus_builds first WHERE first.id<>$1 AND ${initialAttempt('first')}`,[id])).rows;
   for(const first of firsts)if(!eligible||await eligible(first,q))throw Error('builder_initial_attempt_priority');
  }
  if(kind==='model'&&daily.reduce((n,r)=>n+builderCommitment(r),0n)+BigInt(amount)>BigInt(BUILD_LIMITS.dailyModelBudget)||kind==='test'&&daily.length>=BUILD_LIMITS.dailyTestRuns){
   const {reset_at}=(await q.query("SELECT (date_trunc('day',now() AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC' AS reset_at")).rows[0];
   throw new BuilderQuotaWait(kind,new Date(reset_at).toISOString(),kind==='model'?modelCapacity(rows,new Date(reset_at).toISOString()):undefined);
  }
  const effectId=`${id}:${kind}:${own.length+1}`;
  return (await q.query('INSERT INTO claus_build_effects(id,project_id,revision,kind,input,amount) VALUES($1,$2,$3,$4,$5::jsonb,$6) RETURNING *',[effectId,id,p.revision,kind,JSON.stringify(input),amount])).rows[0];
 });}
 async effectState(id:string,owner:string,status:string,output?:unknown,progress?:unknown){return this.db.transaction(async q=>{
  if(status==='running')await q.query('SELECT pg_advisory_xact_lock(6041010)');
  const e=(await q.query('SELECT * FROM claus_build_effects WHERE id=$1',[id])).rows[0];if(!e)throw Error('builder_effect_missing');const p=await this.owned(q,e.project_id,owner);
  if(status==='running'&&e.status==='reserved')await this.coordination.assertCurrent(q);
  if(['completed','failed'].includes(e.status)&&status!==e.status)throw Error('builder_effect_already_final');
  if(['site','surface','operations'].includes(p.purpose)&&['completed','failed'].includes(e.status)&&((output!==undefined&&hash(output)!==hash(e.output))||(progress!==undefined&&hash(progress)!==hash(e.progress))))throw Error('builder_site_receipt_immutable');
  return (await q.query('UPDATE claus_build_effects SET status=$2,output=COALESCE($3::jsonb,output),progress=COALESCE($4::jsonb,progress) WHERE id=$1 RETURNING *',[id,status,output===undefined?null:JSON.stringify(output),progress===undefined?null:JSON.stringify(progress)])).rows[0];
 });}
 async saveVersion(id:string,owner:string,effectId:string,files:BuildFile[],summary:string){return this.db.transaction(async q=>{
  const p=await this.owned(q,id,owner);files=buildFiles(files,buildRuntime(p.runtime));const old=(await q.query('SELECT * FROM claus_build_versions WHERE source_effect=$1',[effectId])).rows[0];if(old){if(old.project_id!==id||old.source_hash!==buildHash(files)||old.summary!==summary)throw Error('builder_version_conflict');return old;}
  const e=(await q.query("SELECT * FROM claus_build_effects WHERE id=$1 AND project_id=$2 AND kind='model' AND status='completed'",[effectId,id])).rows[0];if(!e)throw Error('builder_model_result_required');
  if(e.application_status&&e.application_status!=='applied')throw Error('builder_model_application_final');
  if(e.revision!==p.revision)throw Error('builder_stale_model_result');
  const revision=p.revision+1;
  const v=(await q.query('INSERT INTO claus_build_versions(project_id,revision,source_effect,files,source_hash,summary) VALUES($1,$2,$3,$4::jsonb,$5,$6) RETURNING *',[id,revision,effectId,JSON.stringify(files),buildHash(files),text(summary,1600)])).rows[0];
  await q.query("UPDATE claus_build_effects SET application_status='applied',application_at=now() WHERE id=$1",[effectId]);
  await q.query("UPDATE claus_builds SET revision=$2,status='testing',summary=$3,updated_at=now() WHERE id=$1",[id,revision,summary]);return v;
 });}
 async application(id:string,owner:string,outcome:'rejected'|'superseded',reason:string,blockedSummary?:string){return this.db.transaction(async q=>{
  const e=(await q.query("SELECT * FROM claus_build_effects WHERE id=$1 AND kind='model' AND status='completed' FOR UPDATE",[id])).rows[0];if(!e)throw Error('builder_model_result_required');const p=await this.owned(q,e.project_id,owner);
  if(blockedSummary!==undefined&&(outcome!=='rejected'||e.revision!==p.revision))throw Error('builder_model_rejection_conflict');
  if(e.application_status&&e.application_status!==outcome)throw Error('builder_model_application_final');
  if(!e.application_status)await q.query('UPDATE claus_build_effects SET application_status=$2,application_reason=$3,application_at=now() WHERE id=$1',[id,outcome,text(reason,1600)]);
  // One transaction prevents a lost acknowledgement/lease from leaving a
  // rejected result in a runnable project that buys a replacement on resume.
  if(blockedSummary!==undefined)await q.query("UPDATE claus_builds SET status='blocked',summary=$2,updated_at=now() WHERE id=$1",[e.project_id,text(blockedSummary,1600)]);
 });}
 async status(id:string,owner:string,status:string,summary?:string){return this.db.transaction(async q=>{await this.owned(q,id,owner);await q.query('UPDATE claus_builds SET status=$2,summary=COALESCE($3,summary),updated_at=now() WHERE id=$1',[id,status,summary??null]);});}
 async release(id:string,owner:string,delay=0,nextAt?:string){await this.db.query("UPDATE claus_builds SET lease_owner=NULL,lease_until=NULL,next_at=COALESCE($4::timestamptz,now()+($3*interval '1 second')) WHERE id=$1 AND lease_owner=$2",[id,owner,delay,nextAt??null]);}
}
