import {managedDatabase,managedSchemaReady} from '../database-schema.js';
import {assertBuilderDeployment} from '../builder-coordination.js';
import {completeModelOutput} from '../model-completion.js';
import type {LabDatabase,LabQuery} from '../lab-db.js';
import {BuilderStore} from '../builder-store.js';
import {hash,text} from '../lab-schema.js';
import {validateBlueprint,checkBlueprint} from './blueprint.mjs';
import {BLUEPRINT_HASH,COMPATIBLE_BLUEPRINT_HASHES} from './runtime-pin.js';
import {SiteStore} from './store.js';
import {EMPTY_SITE,sitePlacement,validateSite} from './schema.js';
import {SITE_PUBLIC_FACTS,privateBrief,proposalKey,siteProposal,type SiteQueueResult} from './requests.js';
import {featurePageId,freezeFeatureTarget} from './coordination.js';
import {featureContext} from './quality.js';
export type {SiteSource,SiteProposal,SiteQueueResult} from './requests.js';

export const autonomyEnabled=(c:any)=>c.settings.enabled===true&&c.settings.builder?.enabled===true&&c.settings.siteEditor?.enabled===true&&c.settings.siteEditor?.autonomyEnabled===true;
export function modelJSON(output:any){
 if(!completeModelOutput(output))throw Error('site_incomplete_model_output');
 let content=output?.message?.content;
 if(Array.isArray(content))content=content.map(x=>x.text??'').join('');
 if(typeof content!=='string'||Buffer.byteLength(content)>40000)throw Error('site_invalid_model_output');
 try{return JSON.parse(content.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));}catch{throw Error('site_invalid_model_output');}
}
export function reviewVerdict(value:any){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='accurate,approved,privacySafe,summary,useful,withinScope'||['approved','useful','accurate','privacySafe','withinScope'].some(k=>typeof value[k]!=='boolean'))throw Error('site_invalid_review');
 return {...value,summary:text(value.summary,600)};
}
export const reviewInput=(brief:any,program:any,context?:unknown,runtimeHash=BLUEPRINT_HASH)=>({stage:'review',brief,program,programHash:hash(program),runtimeHash,checks:checkBlueprint(program),...(context?{context}:{})});

// The blueprint already rejects URLs, addresses, HTML and sensitive fields.
// These additional lexical checks are defense in depth, not semantic proof:
// usefulness, hate/abuse, deception and privacy still require independent review.
export function screenSiteProgram(value:unknown){
 const p=validateBlueprint(value),display=[p.title,p.description];
 for(const s of p.sections){
  display.push(s.title);
  if(s.kind==='text')display.push(s.body);
  if(s.kind==='checklist')display.push(...s.items);
  if(s.kind==='directory')for(const i of s.items)display.push(i.label,i.description);
  if(s.kind==='form')for(const i of [...s.inputs,...s.outputs])display.push(i.label,...('unit' in i&&i.unit?[i.unit]:[]));
 }
 const markup=/[<>`]|\*\*|__|~~|!?\[[^\]]*\]\s*\(|(?:^|\n)\s{0,3}#{1,6}\s/;
 const authority=/\b(?:official|owner|founder|admin(?:istrator)?)\s+(?:approved|authorized|endorsed|verified|announcement|policy|instructions?)\b|\b(?:approved|authorized|endorsed|verified)\s+by\s+(?:the\s+)?(?:owner|founder|admin(?:istrator)?|CLAUS)\b|\bguaranteed\s+(?:returns?|profits?|rewards?)\b/i;
 if(display.some(t=>markup.test(t)||authority.test(t)))throw Error('site_program_text_unsafe');
 return p;
}

// Register/propose are trusted entry points. Main resolves actual source records
// and author/visibility server-side; no model tool can supply its own source.
export class SiteFeatureStore{
 constructor(readonly db:LabDatabase){}
 async initialize(){if(managedDatabase())return managedSchemaReady();await this.db.query(`
 CREATE TABLE IF NOT EXISTS claus_site_briefs(id text PRIMARY KEY,brief jsonb NOT NULL,brief_hash text NOT NULL,enabled boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS claus_site_jobs(project_id text PRIMARY KEY REFERENCES claus_builds(id),brief_id text NOT NULL REFERENCES claus_site_briefs(id),brief_hash text NOT NULL,base_revision bigint NOT NULL,program jsonb,program_hash text,generator_effect text UNIQUE REFERENCES claus_build_effects(id),test_effect text UNIQUE REFERENCES claus_build_effects(id),reviewer_effect text UNIQUE REFERENCES claus_build_effects(id),published_revision bigint REFERENCES claus_site_versions(revision),created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS claus_site_intake(id text PRIMARY KEY,request_id text UNIQUE NOT NULL,dedupe_hash text UNIQUE NOT NULL,brief_id text UNIQUE NOT NULL REFERENCES claus_site_briefs(id),source_author text NOT NULL,project_request_id text UNIQUE NOT NULL,project_id text UNIQUE REFERENCES claus_builds(id),status text NOT NULL DEFAULT 'queued',wait_reason text,next_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS claus_site_requests(id text PRIMARY KEY,input_hash text NOT NULL,intake_id text NOT NULL REFERENCES claus_site_intake(id),created_at timestamptz NOT NULL DEFAULT now());
 CREATE INDEX IF NOT EXISTS claus_site_intake_queue ON claus_site_intake(created_at,id) WHERE project_id IS NULL;`);}
 async register(value:any){
  if(!value||typeof value!=='object'||Array.isArray(value)||!['facts,goal,id,title','facts,goal,id,placement,title'].includes(Object.keys(value).sort().join(','))||typeof value.id!=='string'||!/^public-[a-z0-9-]{1,64}$/.test(value.id))throw Error('site_invalid_public_brief');
  if(Object.hasOwn(value,'placement')&&value.placement===undefined)throw Error('site_invalid_placement');
  const brief={id:value.id,title:text(value.title,100),goal:text(value.goal,1800),facts:text(value.facts,1800),...(Object.hasOwn(value,'placement')?{placement:sitePlacement(value.placement)}:{})};
  if(/[<>\u202a-\u202e\u2066-\u2069]/.test(JSON.stringify(brief)))throw Error('site_invalid_public_brief');
  const digest=hash(brief);
  await this.db.query('INSERT INTO claus_site_briefs(id,brief,brief_hash) VALUES($1,$2::jsonb,$3) ON CONFLICT DO NOTHING',[brief.id,JSON.stringify(brief),digest]);
  const saved=await this.brief(brief.id);if(saved.brief_hash!==digest)throw Error('site_brief_immutable');return saved;
 }
 async brief(id:string){const row=(await this.db.query('SELECT * FROM claus_site_briefs WHERE id=$1',[id])).rows[0];if(!row)throw Error('site_public_brief_missing');if(hash(row.brief)!==row.brief_hash)throw Error('site_brief_immutable');return row;}
 async disable(id:string){await this.db.query('UPDATE claus_site_briefs SET enabled=false WHERE id=$1',[id]);return this.brief(id);}
 async requestSource(id:string){
  const row=(await this.db.query('SELECT b.brief FROM claus_site_requests r JOIN claus_site_intake i ON i.id=r.intake_id JOIN claus_site_briefs b ON b.id=i.brief_id WHERE r.id=$1',[id])).rows[0];
  return row?.brief.source??null;
 }
 async list(options:{includePrivate?:boolean;id?:string}={}){
  if(options.id!==undefined&&(typeof options.id!=='string'||!/^[-A-Za-z0-9_:]{1,160}$/.test(options.id)))throw Error('site_invalid_request');
  const rows=(await this.db.query(`SELECT b.id,b.brief,b.brief_hash,b.enabled,j.project_id,p.status,p.summary,j.program_hash,j.published_revision,i.request_id,i.project_request_id,i.status AS intake_status,i.wait_reason,COALESCE(p.next_at,i.next_at) AS next_at
   FROM claus_site_briefs b LEFT JOIN claus_site_intake i ON i.brief_id=b.id LEFT JOIN claus_site_jobs j ON j.brief_id=b.id LEFT JOIN claus_builds p ON p.id=j.project_id
   WHERE ($1::text IS NULL OR b.id=$1 OR j.project_id=$1 OR i.request_id=$1 OR EXISTS(SELECT 1 FROM claus_site_requests r WHERE r.intake_id=i.id AND r.id=$1))
   ORDER BY CASE WHEN p.status IS NOT NULL AND p.status NOT IN ('published','blocked','ready_for_review','untested','needs_changes','editing') OR i.id IS NOT NULL AND i.project_id IS NULL AND b.enabled THEN 0 ELSE 1 END,b.created_at DESC,b.id,j.created_at DESC LIMIT 30`,[options.id??null])).rows;
  return rows.map(row=>{
   if(hash(row.brief)!==row.brief_hash)throw Error('site_brief_immutable');
   const status=row.status??(!row.enabled?'disabled':row.intake_status),isPrivate=privateBrief(row.brief);
   const {source,...brief}=row.brief;
   return {...row,status,placement:sitePlacement(row.brief.placement),brief:options.includePrivate===true?row.brief:isPrivate?{id:row.id,placement:'club'}:brief,
    summary:isPrivate&&options.includePrivate!==true?'Private Club work; status: '+(status??'standing')+'.':row.summary};
  });
 }
 async propose(requestId:string,value:unknown,target?:{pageId:string;expectedRevision:number}):Promise<SiteQueueResult>{
  if(typeof requestId!=='string'||!/^[A-Za-z0-9:_-]{1,160}$/.test(requestId))throw Error('site_invalid_request');
  if(target&&(!/^[a-z][a-z0-9-]{0,39}$/.test(target.pageId)||!Number.isSafeInteger(target.expectedRevision)||target.expectedRevision<1))throw Error('site_target_invalid');
  const proposal=siteProposal(value),inputHash=hash(target?{proposal,target}:proposal),key=target?hash({proposalKey:proposalKey(proposal),target}):proposalKey(proposal);
  if(target&&proposal.source.visibility==='public'&&proposal.placement==='club')throw Error('site_private_source_refused');
  return this.db.transaction(async q=>{
   await q.query('SELECT pg_advisory_xact_lock(6041012)');
   const old=(await q.query('SELECT * FROM claus_site_requests WHERE id=$1',[requestId])).rows[0];
   if(old){
    if(old.input_hash!==inputHash)throw Error('site_request_conflict');
    return {...await this.intakeResult(q,old.intake_id),requestId,replayed:true,deduplicated:false};
   }
   let intake=(await q.query('SELECT * FROM claus_site_intake WHERE dedupe_hash=$1',[key])).rows[0];
   const deduplicated=!!intake;
   if(!intake){
    const counts=(await q.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE source_author=$1)::int AS author FROM claus_site_intake WHERE created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",[proposal.source.authorId])).rows[0];
    if(counts.author>=1)throw Error('site_author_daily_limit');
    if(counts.total>=12)throw Error('site_daily_intake_limit');
    let frozenTarget;
    if(target){
     const control=(await q.query('SELECT * FROM claus_site_control WHERE id FOR UPDATE')).rows[0];
     if(!control?.enabled)throw Error('site_disabled');
     if(Number(control.revision??0)!==target.expectedRevision)throw Error('site_revision_conflict');
     const row=(await q.query('SELECT manifest FROM claus_site_versions WHERE revision=$1',[target.expectedRevision])).rows[0];
     frozenTarget=freezeFeatureTarget(validateSite(row?.manifest),target.expectedRevision,target.pageId,proposal.placement);
    }
    const brief={id:'request-'+key,...proposal,facts:SITE_PUBLIC_FACTS,...(frozenTarget?{target:frozenTarget}:{})};
    await q.query('INSERT INTO claus_site_briefs(id,brief,brief_hash) VALUES($1,$2::jsonb,$3)',[brief.id,JSON.stringify(brief),hash(brief)]);
    intake=(await q.query('INSERT INTO claus_site_intake(id,request_id,dedupe_hash,brief_id,source_author,project_request_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',['intake:'+key,requestId,key,brief.id,proposal.source.authorId,'site-proposal:'+key])).rows[0];
   }
   await q.query('INSERT INTO claus_site_requests(id,input_hash,intake_id) VALUES($1,$2,$3)',[requestId,inputHash,intake.id]);
   return {...await this.intakeResult(q,intake.id),requestId,replayed:false,deduplicated};
  });
 }
 private async intakeResult(q:LabQuery,id:string):Promise<SiteQueueResult>{
  const i=(await q.query('SELECT i.*,b.enabled,b.brief,p.status AS project_status,p.next_at AS project_next_at FROM claus_site_intake i JOIN claus_site_briefs b ON b.id=i.brief_id LEFT JOIN claus_builds p ON p.id=i.project_id WHERE i.id=$1',[id])).rows[0];
  if(!i)throw Error('site_request_missing');
  return {status:i.project_status??(i.enabled?i.status:'disabled'),canonicalRequestId:i.request_id,briefId:i.brief_id,projectRequestId:i.project_request_id,projectId:i.project_id??null,placement:sitePlacement(i.brief.placement),nextAt:new Date(i.project_next_at??i.next_at).toISOString(),...(i.wait_reason?{reason:i.wait_reason}:{})};
 }
 // One transaction shares Builder's admission lock and checks. There is no
 // startBuilder call here: main schedules the returned projectId after commit.
 async drainQueued():Promise<SiteQueueResult>{return this.db.transaction(async q=>{
  await q.query('SELECT pg_advisory_xact_lock(6041010)');
  const control=(await q.query('SELECT enabled FROM claus_site_control WHERE id')).rows[0];
  if(!control?.enabled)return {status:'disabled'};
  const intake=(await q.query("SELECT i.* FROM claus_site_intake i JOIN claus_site_briefs b ON b.id=i.brief_id WHERE i.project_id IS NULL AND (i.next_at<=now() OR i.status='waiting_project_quota') AND b.enabled ORDER BY i.created_at,i.id LIMIT 1 FOR UPDATE OF i")).rows[0];
  if(!intake)return {status:'idle'};
  // Reuse the same SQL transaction; BuilderStore remains the quota authority.
  const scoped:LabDatabase={query:q.query.bind(q),transaction:fn=>fn(q)};
  const usage=await new BuilderStore(scoped).usage('claus');
  const wait=async(status:string,reason:string,nextAt:string)=>{
   await q.query('UPDATE claus_site_intake SET status=$2,wait_reason=$3,next_at=$4 WHERE id=$1',[intake.id,status,reason,nextAt]);
   return {...await this.intakeResult(q,intake.id),requestId:intake.request_id};
  };
  if(usage.sharedDailyModelRequestsRemaining!==null&&usage.sharedDailyModelRequestsRemaining<1)return wait('waiting_model_quota','builder_daily_model_budget',usage.resetsAt);
  if((await q.query('SELECT id FROM claus_builds WHERE lease_until>now() LIMIT 1')).rows.length)return wait('waiting_builder','builder_busy',new Date(Date.now()+60000).toISOString());
  try{
   const job=await this.createUsing(scoped,intake.brief_id,intake.project_request_id);
   return {...await this.intakeResult(q,intake.id),status:'admitted',requestId:intake.request_id,projectId:job.project_id};
  }catch(error){
   const reason=error instanceof Error?error.message:String(error);
   if(['site_disabled','site_public_brief_disabled'].includes(reason))return wait('disabled',reason,new Date(Date.now()+60000).toISOString());
   if(reason==='site_brief_already_running')return wait('waiting_builder',reason,new Date(Date.now()+60000).toISOString());
   throw error;
  }
 });}
 async create(briefId:string,requestId?:string){return this.createUsing(this.db,briefId,requestId);}
 private async createUsing(db:LabDatabase,briefId:string,requestId?:string){
  const intake=(await db.query('SELECT * FROM claus_site_intake WHERE brief_id=$1',[briefId])).rows[0];
  requestId??=intake?.project_request_id??'site:'+briefId;
  if(typeof requestId!=='string'||!/^[A-Za-z0-9:_-]{1,160}$/.test(requestId))throw Error('site_invalid_request');
  if(intake&&intake.project_request_id!==requestId)throw Error('site_proposal_request_required');
  const features=new SiteFeatureStore(db),brief=await features.brief(briefId);if(!brief.enabled)throw Error('site_public_brief_disabled');
  const site=await new SiteStore(db).current();if(!site.enabled)throw Error('site_disabled');
  let baseRevision=site.revision;
  const p=await new BuilderStore(db).create('site:'+hash({briefId,requestId}).slice(0,32),brief.brief.title,brief.brief.goal,'claus','source',undefined,'javascript','site',{
   prepare:async q=>{
    const b=(await q.query('SELECT * FROM claus_site_briefs WHERE id=$1 FOR UPDATE',[briefId])).rows[0];
    if(!b?.enabled||b.brief_hash!==brief.brief_hash)throw Error('site_public_brief_disabled');
    if(hash(b.brief)!==brief.brief_hash)throw Error('site_brief_immutable');
    const c=(await q.query('SELECT * FROM claus_site_control WHERE id FOR UPDATE')).rows[0];
    if(!c?.enabled)throw Error('site_disabled');baseRevision=brief.brief.target?.revision??Number(c.revision??0);
    const active=(await q.query("SELECT j.project_id FROM claus_site_jobs j JOIN claus_builds p ON p.id=j.project_id WHERE j.brief_id=$1 AND p.status NOT IN ('published','blocked','untested')",[briefId])).rows;
    if(active.length)throw Error('site_brief_already_running');
   },
   save:async(q,id)=>{
    await q.query('INSERT INTO claus_site_jobs(project_id,brief_id,brief_hash,base_revision) VALUES($1,$2,$3,$4)',[id,briefId,brief.brief_hash,baseRevision]);
    await q.query("UPDATE claus_builds SET status='queued' WHERE id=$1",[id]);
    if(intake)await q.query("UPDATE claus_site_intake SET project_id=$2,status='admitted',wait_reason=NULL,next_at=now() WHERE id=$1",[intake.id,id]);
   }
  });return features.job(p.id);
 }
 async job(id:string){const r=(await this.db.query('SELECT j.*,b.brief,b.enabled,b.brief_hash AS live_brief_hash FROM claus_site_jobs j JOIN claus_site_briefs b ON b.id=j.brief_id WHERE j.project_id=$1',[id])).rows[0];if(!r)throw Error('site_job_missing');if(r.live_brief_hash!==r.brief_hash||hash(r.brief)!==r.brief_hash)throw Error('site_brief_immutable');return r;}
 async attach(id:string,owner:string,stage:'generator'|'test'|'reviewer',effectId:string){
  if(!['generator','test','reviewer'].includes(stage))throw Error('site_invalid_stage');
  return this.db.transaction(async q=>{
   const p=(await q.query("SELECT id FROM claus_builds WHERE id=$1 AND purpose='site' AND lease_owner=$2 AND lease_until>now() FOR UPDATE",[id,owner])).rows[0];if(!p)throw Error('builder_lease_lost');
   const effect=(await q.query('SELECT * FROM claus_build_effects WHERE id=$1 AND project_id=$2',[effectId,id])).rows[0];if(!effect||effect.kind!==(stage==='test'?'test':'model'))throw Error('site_invalid_effect');
   const job=(await q.query('SELECT * FROM claus_site_jobs WHERE project_id=$1 FOR UPDATE',[id])).rows[0];
   if(job[stage+'_effect']&&job[stage+'_effect']!==effectId)throw Error('site_effect_immutable');
   await q.query(`UPDATE claus_site_jobs SET ${stage}_effect=$2 WHERE project_id=$1`,[id,effectId]);
  });
 }
 async candidate(id:string,owner:string,effect:any){
  const program=screenSiteProgram(modelJSON(effect.output));
  return this.db.transaction(async q=>{
   const p=(await q.query("SELECT id FROM claus_builds WHERE id=$1 AND purpose='site' AND lease_owner=$2 AND lease_until>now() FOR UPDATE",[id,owner])).rows[0];if(!p)throw Error('builder_lease_lost');
   const j=(await q.query('SELECT * FROM claus_site_jobs WHERE project_id=$1 FOR UPDATE',[id])).rows[0];
   const e=(await q.query("SELECT * FROM claus_build_effects WHERE id=$1 AND project_id=$2 AND status='completed'",[j.generator_effect,id])).rows[0];
   if(!e||e.id!==effect.id||hash(screenSiteProgram(modelJSON(e.output)))!==hash(program))throw Error('site_generator_receipt_required');
   if(j.program_hash&&j.program_hash!==hash(program))throw Error('site_candidate_immutable');
   await q.query('UPDATE claus_site_jobs SET program=$2::jsonb,program_hash=$3 WHERE project_id=$1',[id,JSON.stringify(program),hash(program)]);
  });
 }
 async publish(id:string,owner:string){return this.db.transaction(async q=>{
  await q.query('SELECT pg_advisory_xact_lock(6041010)');
  const p=(await q.query("SELECT * FROM claus_builds WHERE id=$1 AND purpose='site' AND owner_scope='claus' FOR UPDATE",[id])).rows[0];if(!p)throw Error('builder_lease_lost');
  const j=(await q.query('SELECT * FROM claus_site_jobs WHERE project_id=$1 FOR UPDATE',[id])).rows[0];
  if(!j)throw Error('site_job_missing');
  // Terminal jobs always return their original receipt, including after a
  // rollback or revoke; they never acquire fresh authority to publish again.
  if(j.published_revision)return {revision:Number(j.published_revision),published:true,replayed:true};
  await assertBuilderDeployment(q);
  if(!(await q.query('SELECT id FROM claus_builds WHERE id=$1 AND lease_owner=$2 AND lease_until>now()',[id,owner])).rows.length)throw Error('builder_lease_lost');
  const b=(await q.query('SELECT * FROM claus_site_briefs WHERE id=$1 FOR UPDATE',[j.brief_id])).rows[0];
  if(!b?.enabled||b.brief_hash!==j.brief_hash)throw Error('site_public_brief_disabled');
  if(hash(b.brief)!==j.brief_hash)throw Error('site_brief_immutable');
  const control=(await q.query('SELECT * FROM claus_site_control WHERE id FOR UPDATE')).rows[0];
  if(!control?.enabled)throw Error('site_disabled');
  const readManifest=async(revision:any)=>{
   if(!Number(revision))return validateSite(EMPTY_SITE);
   const row=(await q.query('SELECT manifest FROM claus_site_versions WHERE revision=$1',[revision])).rows[0];
   if(!row)throw Error('site_revision_missing');return validateSite(row.manifest);
  };
  const old=await readManifest(control.revision),baseline=await readManifest(j.base_revision);
  const pageId=featurePageId(j.brief_id,b.brief);
  const target=(manifest:typeof old)=>manifest.pages.find(page=>page.id===pageId)??null;
  if(b.brief.target&&hash(target(baseline))!==b.brief.target.pageHash)throw Error('site_target_invalid');
  if(hash(target(baseline))!==hash(target(old)))throw Error('site_target_page_conflict');
  const es=(await q.query("SELECT * FROM claus_build_effects WHERE project_id=$1 AND status='completed'",[id])).rows;
  const gen=es.find(e=>e.id===j.generator_effect),test=es.find(e=>e.id===j.test_effect),review=es.find(e=>e.id===j.reviewer_effect);
  const program=screenSiteProgram(j.program),programHash=hash(program),checks=checkBlueprint(program);
  if(!gen||!test||!review||gen.id===review.id||gen.kind!=='model'||test.kind!=='test'||review.kind!=='model'||programHash!==j.program_hash||hash(screenSiteProgram(modelJSON(gen.output)))!==programHash)throw Error('site_provenance_required');
  const testedRuntime=test.input.runtimeHash;
  if(!COMPATIBLE_BLUEPRINT_HASHES.includes(testedRuntime)||hash(test.input)!==hash({programHash,runtimeHash:testedRuntime})||hash(test.output)!==hash({...checks,programHash,runtimeHash:testedRuntime}))throw Error('site_trusted_checks_required');
  const recordedReview=JSON.parse(review.input.input?.[0]?.content??'null');
  const context=recordedReview&&Object.hasOwn(recordedReview,'context')?featureContext(baseline,b.brief):undefined;
  if(hash(recordedReview)!==hash(reviewInput(b.brief,program,context,testedRuntime)))throw Error('site_review_binding_required');
  const verdict=reviewVerdict(modelJSON(review.output));
  if(['approved','useful','accurate','privacySafe','withinScope'].some(k=>verdict[k]!==true))throw Error('site_review_declined');
  const [{n}]=(await q.query("SELECT count(*)::int n FROM claus_site_versions WHERE actor='claus' AND created_at>now()-interval '1 hour'")).rows;if(n>=6)throw Error('site_hourly_limit');
  const placement=sitePlacement(b.brief.placement);
  if(b.brief.source?.visibility==='private'&&placement!=='club')throw Error('site_private_source_requires_club');
  const signature=(value:any)=>hash({...value,tests:[]});
  if(old.pages.some(page=>page.id!==pageId&&sitePlacement(page.placement)===placement&&page.blocks.some(block=>block.kind==='feature'&&signature(block.program)===signature(program))))throw Error('site_duplicate_feature');
  const page={id:pageId,title:program.title.slice(0,60),description:program.description.slice(0,200),placement,blocks:[{id:pageId,kind:'feature',title:program.title,body:'',runtimeHash:testedRuntime,program}]};
  // Preserve unrelated pages, their order, appearance and exact programs. Only
  // the frozen target is replaced while the current manifest is locked.
  const pages=old.pages.some(p=>p.id===pageId)?old.pages.map(p=>p.id===pageId?page:p):[...old.pages,page];
  const manifest=validateSite({...old,pages});
  const reason=placement==='club'?'Reviewed private Club feature':'Reviewed public feature: '+b.brief.title;
  const r=(await q.query("INSERT INTO claus_site_versions(request_id,input_hash,manifest,reason,actor) VALUES($1,$2,$3::jsonb,$4,'claus') RETURNING revision",['site-feature:'+id,hash({id,programHash,baseRevision:j.base_revision,targetPageHash:hash(target(baseline)),mergedRevision:Number(control.revision??0),reviewId:review.id,runtimeHash:testedRuntime}),JSON.stringify(manifest),reason])).rows[0];
  await q.query('UPDATE claus_site_control SET revision=$1 WHERE id',[r.revision]);
  await q.query('UPDATE claus_site_jobs SET published_revision=$2 WHERE project_id=$1',[id,r.revision]);
  await q.query("UPDATE claus_builds SET status='published',summary=$2,updated_at=now() WHERE id=$1",[id,'Published '+(placement==='club'?'in private Club':'on public '+placement)+' as revision '+r.revision]);
  return {revision:Number(r.revision),published:true,replayed:false};
 });}
}
