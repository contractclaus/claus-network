import {createHash} from 'node:crypto';
import {productionLabDatabase,type LabDatabase,type LabQuery} from './lab-db.js';

const actions=['development','development_plan','development_observe','development_decide'];
export const developmentActions=new Set(actions);
const fail=(s:string):never=>{throw Error('development_'+s);};
const text=(v:any,max:number)=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!/-----BEGIN|Bearer\s|(?:password|api[-_]?key|secret)\s*[=:]\s*\S{8}/i.test(v);
const workId=(v:any)=>typeof v==='string'&&/^nw_[a-z0-9_-]{1,80}$/.test(v);
const fingerprint=(v:any)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const ordered=(v:any):any=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v;
export function compareDevelopment(before:any[],after:any[],metrics:any[]) {
 return metrics.map(m=>{
  const b=before.find(x=>x.name===m.name),a=after.find(x=>x.name===m.name);
  const known=Number.isFinite(b?.value)&&Number.isFinite(a?.value)&&b.unit===m.unit&&a.unit===m.unit;
  const delta=known?a.value-b.value:null;
  return {name:m.name,unit:m.unit,before:b?.value??null,after:a?.value??null,delta,
   passes:known?(m.direction==='lower'?a.value<=m.target:a.value>=m.target):null,
   regressed:delta!==null?(m.direction==='lower'?delta>0:delta<0):null,
   meaning:'Comparison of evidence-linked recorded observations; causation and representativeness require the stated method.'};
 });
}
async function latest(db:LabQuery,id:string){return (await db.query('SELECT document FROM claus_network_measurements WHERE subject=$1 ORDER BY id DESC LIMIT 1',['development:'+id])).rows[0]?.document??null;}
export async function developmentOverview(db:LabQuery=productionLabDatabase(),now=Date.now()) {
 const rows=(await db.query("SELECT DISTINCT ON (subject) subject,document FROM claus_network_measurements WHERE subject LIKE 'development:%' ORDER BY subject,id DESC")).rows;
 const items=rows.map((r:any)=>r.document).sort((a:any,b:any)=>a.nextReviewAt.localeCompare(b.nextReviewAt));
 return {items:items.map((x:any)=>({id:x.id,revision:x.revision,kind:x.kind,status:x.status,hypothesis:x.hypothesis,nextReviewAt:x.nextReviewAt,decision:x.decision??null,
  due:x.status==='observing'&&Date.parse(x.nextReviewAt)<=now})),
  due:items.filter((x:any)=>x.status==='observing'&&Date.parse(x.nextReviewAt)<=now).map((x:any)=>x.id),
  next:'Advance an existing useful task. Before a substantive improvement, bind its expected benefit and baseline with network_care development_plan. Record actual outcome and decide retain, revert or inconclusive. Reuse completed work; never create traffic or a paid task merely to populate this register.',
  authorityChanged:false,meaning:'Internal development decisions, not a public achievement feed or proof of autonomous general improvement.'};
}
export function developmentCycles({database=productionLabDatabase(),validEvidence,now=Date.now,actor='claus'}:{database?:LabDatabase;validEvidence:(r:any)=>boolean;now?:()=>number;actor?:'claus'|'operator'}) {
 async function evidence(db:LabQuery,refs:any){
  if(!Array.isArray(refs)||!refs.length||refs.length>8||new Set(refs).size!==refs.length||refs.some(x=>!/^j_[1-9][0-9]*$/.test(x)))fail('evidence_required');
  const rows=(await db.query('SELECT id,kind,summary,data,visibility,created_at FROM claus_journal WHERE id::text=ANY($1::text[])',[refs.map((x:string)=>x.slice(2))])).rows;
  if(rows.length!==refs.length||rows.some(r=>!validEvidence(r)))fail('evidence_unavailable');
  return rows.map(r=>({id:'j_'+r.id,tool:r.summary,at:r.created_at,sha256:fingerprint(ordered(r))}));
 }
 async function observations(db:LabQuery,input:any,metrics:any[]) {
  if(!Array.isArray(input)||input.length!==metrics.length)fail('observations_required');
  const seen=new Set();const out=[];
  for(const x of input){
   const metric=metrics.find(m=>m.name===x.name);
   if(!metric||seen.has(x.name)||x.unit!==metric.unit||!(x.value===null||typeof x.value==='number'&&Number.isFinite(x.value))||!text(x.method,1200))fail('observation_invalid');
   seen.add(x.name);const sources=await evidence(db,x.evidence);
   out.push({name:x.name,unit:x.unit,value:x.value,method:x.method,evidence:sources,recordedBy:actor});
  }
  return out;
 }
 return {async call(args:any){
  if(!developmentActions.has(args.action))fail('action_invalid');
  if(args.action==='development'){
   if(args.id!==undefined&&!workId(args.id))fail('work_invalid');
   return args.id?{cycle:await latest(database,args.id),authorityChanged:false}:developmentOverview(database,now());
  }
  if(!workId(args.id)||!Number.isInteger(args.expectedRevision)||args.expectedRevision<0)fail('revision_required');
  const requestHash=fingerprint(ordered(args));
  return database.transaction(async db=>{
   await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['development:'+args.id]);
   const previous=await latest(db,args.id);
   if(previous?.requestHash===requestHash)return {...previous,replayed:true};
   if((previous?.revision??0)!==args.expectedRevision)fail('revision_conflict');
   const work=(await db.query('SELECT id,status,revision,goal,evidence FROM claus_network_work WHERE id=$1',[args.id])).rows[0];
   if(!work)fail('work_missing');
   let next:any;
   if(args.action==='development_plan'){
    if(previous||!['ready','working','waiting'].includes(work.status))fail('active_work_required');
    if(!['repair','feature','capability','model'].includes(args.kind)||!text(args.hypothesis,1600)||!text(args.rollback,1600)||!Array.isArray(args.metrics)||!args.metrics.length||args.metrics.length>6)fail('plan_invalid');
    if(new Set(args.metrics.map((m:any)=>m.name)).size!==args.metrics.length)fail('metric_duplicate');
    const metrics=args.metrics.map((m:any)=>{
     if(!text(m.name,80)||!text(m.unit,60)||!['lower','higher'].includes(m.direction)||typeof m.target!=='number'||!Number.isFinite(m.target))fail('metric_invalid');
     return {name:m.name,unit:m.unit,direction:m.direction,target:m.target};
    });
    if(args.kind==='capability'&&(!text(args.need,1200)||!text(args.existingMeans,1600)||!text(args.accessBasis,1600)))fail('capability_need_required');
    const baseline=await observations(db,args.observations,metrics);
    next={id:args.id,kind:args.kind,status:'observing',hypothesis:args.hypothesis,rollback:args.rollback,metrics,baseline,after:[],
     ...(args.kind==='capability'?{acquisition:{need:args.need,existingMeans:args.existingMeans,accessBasis:args.accessBasis}}:{}),
     originalWorkRevision:work.revision,createdAt:new Date(now()).toISOString(),createdBy:actor};
   }else{
    if(!previous||previous.status!=='observing')fail('active_cycle_required');
    next={...previous};
    if(args.action==='development_observe'){
     next.after=await observations(db,args.observations,previous.metrics);
     next.comparison=compareDevelopment(previous.baseline,next.after,previous.metrics);
     if(previous.kind==='capability'){
      if(!text(args.integrationRef,1000)||!text(args.capabilityName,120))fail('capability_delivery_required');
      next.acquisition={...previous.acquisition,integrationRef:args.integrationRef,capabilityName:args.capabilityName};
     }
    }else{
     if(!['retain','revert','inconclusive'].includes(args.decision)||!text(args.reason,1600))fail('decision_invalid');
     if(args.decision==='retain'&&(!previous.comparison?.length||previous.comparison.some((m:any)=>m.passes!==true||m.regressed!==false)))fail('benefit_not_established');
     next.decision={decision:args.decision,reason:args.reason,evidence:await evidence(db,args.evidenceRefs),at:new Date(now()).toISOString(),recordedBy:actor,
      execution:'A retain/revert decision does not itself deploy or roll back code. Use original deployment controls and preserve their receipts.'};
     next.status=args.decision==='inconclusive'?'observing':'decided';
    }
   }
   const review=Date.parse(args.nextReviewAt);
   if(next.status==='observing'&&(!Number.isFinite(review)||review<=now()||review>now()+30*86400000))fail('review_time_required');
   next.nextReviewAt=next.status==='observing'?new Date(review).toISOString():previous.nextReviewAt;
   next.revision=args.expectedRevision+1;next.requestHash=requestHash;next.updatedAt=new Date(now()).toISOString();
   await db.query('INSERT INTO claus_network_measurements(subject,document) VALUES($1,$2::jsonb)',['development:'+args.id,JSON.stringify(next)]);
   return {...next,authorityChanged:false};
  });
 }};
}

export const developmentHelp='Self-development: development {id?} reads cycles and due assessments. development_plan requires id of existing active work, expectedRevision:0, kind repair|feature|capability|model, hypothesis, rollback, metrics [{name,unit,direction:lower|higher,target}], observations [{name,unit,value:number|null,method,evidence:[original successful j_N]}], nextReviewAt ISO within30days. A capability plan also requires need, existingMeans and accessBasis. Before changing anything retain a real baseline. development_observe uses id, current expectedRevision, observations and nextReviewAt; capability observations require integrationRef and capabilityName for the registered useful integration. development_decide uses id, expectedRevision, decision retain|revert|inconclusive, reason, evidenceRefs; inconclusive also needs nextReviewAt. Retain requires all specified targets met without a measured regression. These are private, evidence-linked recorded assessments; missing values stay null and correlation is not causation. Deployment/rollback and capability registration use their existing tools. No new work, purchase, permission, posting or model call is created by this register.';
