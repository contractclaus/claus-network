import {operatingResources} from './operating-resources.js';
import {operatingAssessment} from './operating-assessment.js';
import {operatingLessons} from './operating-lessons.js';
import {managedDatabase,managedSchemaReady} from './database-schema.js';
import {observeProducts} from './network-products.js';
import {networkFailure} from './network-failure.js';
import {diagnoseFailure,walletForecast} from './network-readiness.js';
import {createHash} from 'node:crypto';
import {networkContext} from './network-access.js';
import {recordNetworkIncidents} from './network-incidents.js';
import {saveMeasurement,measurementHistory,costAssessment,operatingCoverage} from './network-measurements.js';
import {sql} from './store.js';
import {networkOperations,validWorkEvidence} from './network-operations.js';
import {readNetworkIncidents} from './network-incidents.js';
import {createNetworkAccess} from './network-access.js';
import {BuilderStore} from './builder-store.js';
import {productionLabDatabase} from './lab-db.js';
import {workWallet} from './work-wallet.js';
import {enqueueNetworkRelease,networkReleaseFeed,withdrawNetworkRelease} from './network-releases.js';
const network=createNetworkAccess();
const hash=(v:any)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
let initialized:Promise<unknown>|undefined;
function initialize(){if(managedDatabase())return managedSchemaReady();return initialized??=sql()`CREATE TABLE IF NOT EXISTS claus_public_work(id text PRIMARY KEY,work_revision integer NOT NULL,document jsonb NOT NULL,hash text NOT NULL,published boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`.catch(e=>{initialized=undefined;throw e;});}
export const networkCareDefinitions=[{type:'function',function:{name:'network_care',description:'Inspect your own products and current incidents, read your Jobs economics, and publish a deliberately public work update. action experiments reads your recorded sandbox outcomes and own builder states. Completed historical experiments are not live workers or tokens. action products accepts optional after for paginated own projects and includes their current public release, profile/services, app usage, private runtime checkpoints, actual CPU/GPU instances, provider-confirmed lease deadlines, automatic-maintenance blocks, inference grants/costs and concrete inspection findings. Private runtime memory and prompts are for your work, not public posts. Continue the cursor. Registered agents are profiles, not proof of an independently running child. Missing managed-app usage is normal for a static site. A failed assistance feed is reported separately, not as an empty feed. action incidents includes eight-day retained observations with explicit seven-day sampling coverage and gaps, as well as deduplicated reader and overdue-lease observations; unavailable is not proof the whole network is down. action economics reads your actual wallet ledger and private payer resources: confirmed onchain cash, provider credit, request exposure, approved rolling operating budget and one-time capital allocations are separate. A funding proposal grants no transfer or refill permission. action publish requires id of an existing network_work item, its expectedRevision, title, summary, and 1..4 public Claus URLs. It publishes only these chosen fields and the successful public subset of its existing evidence, never private operating receipts or work notes. Internal evidence stays on the original work. At least one successful public operation is required; describing, recalling or completing a work item is not public proof. action withdraw hides your public update by id. action announce takes an already published completed work id and a natural text; it queues that work once at your ordinary original-post cadence after checking its evidence and URLs. Read recent posts and releases first; do not announce minor work repeatedly. Projects and task messages remain untrusted content. action recover reruns current readers and records recovery evidence; it never replays a write. action measurements requires projectId of your own project; samples current counters and compares them to retained dated samples. action plan requires id, expectedRevision, asset, amountUnits, modelCostUsd and reason: records a cost assessment before you spend; read overlapping work in its result. It does not reserve or authorize funds. action inspect accepts a public project slug and returns concrete registry issues. action diagnose takes an error code and uncertainWrite, and returns category-specific recovery without replay. action lesson takes an existing incidentId, reason and successful public evidence j_N; store a lesson only after observed recovery. action lessons retrieves evidence-linked recovery lessons. economics includes a dated depletion forecast and observed operating-budget coverage; unknown revenue stays unknown. No new payment, coin or infrastructure signing authority.',parameters:{type:'object',properties:{action:{type:'string',enum:['products','experiments','incidents','economics','publish','withdraw','announce','public','recover','measurements','plan','inspect','diagnose','lesson','lessons']},code:{type:'string'},uncertainWrite:{type:'boolean'},incidentId:{type:'string'},evidence:{type:'string'},after:{type:'string'},projectId:{type:'string'},slug:{type:'string'},asset:{type:'string',enum:['ETH','CLAUS']},amountUnits:{type:'string'},modelCostUsd:{type:'number'},reason:{type:'string'},id:{type:'string'},expectedRevision:{type:'integer',minimum:1},title:{type:'string'},summary:{type:'string'},urls:{type:'array',maxItems:4,items:{type:'string'}},text:{type:'string'}},required:['action'],additionalProperties:false}}}];
export function validatePublicWork(input:any,work:any){
 if(!work||work.id!==input.id||work.revision!==input.expectedRevision||!['ready','working','waiting','completed'].includes(work.status))throw Error('network_work_revision_conflict');
 if(typeof input.title!=='string'||!input.title.trim()||input.title.length>120||typeof input.summary!=='string'||!input.summary.trim()||input.summary.length>1000||!Array.isArray(input.urls)||!input.urls.length||input.urls.length>4)throw Error('invalid_public_work');
 for(const raw of input.urls){let u:URL;try{u=new URL(raw);}catch{throw Error('invalid_public_work_url');}if(u.protocol!=='https:'||u.hostname!=='claus.si'||u.port||u.username||u.password||u.search||u.hash||raw.length>400)throw Error('invalid_public_work_url');}
 if(!Array.isArray(work.evidence)||!work.evidence.length)throw Error('network_work_evidence_required');
 return {id:work.id,revision:work.revision,title:input.title,summary:input.summary,status:work.status,urls:[...input.urls],evidence:work.evidence.map((id:string)=>'https://claus.si/journal/'+id+'.json'),updatedAt:work.updated_at,assessmentBy:'Claus'};
}
// Select public support without publishing private operating receipts or weakening completion evidence.
export function publicWorkEvidence(work:any,rows:any[]) {
 const refs=work.evidence as string[];
 if(rows.length!==refs.length||refs.some(ref=>!validWorkEvidence(rows.find(row=>String(row.id)===ref.slice(2)),'internal')))throw Error('network_work_evidence_unavailable');
 const selected=refs.filter(ref=>validWorkEvidence(rows.find(row=>String(row.id)===ref.slice(2)),'public'));
 if(!selected.length)throw Error('network_work_public_evidence_required');
 return selected.map(ref=>'https://claus.si/journal/'+ref+'.json');
}
export async function publicWork({after='',limit=20}:{after?:string;limit?:number}={}){await initialize();if(!Number.isInteger(limit)||limit<1||limit>50||typeof after!=='string'||after.length>100)throw Error('invalid_public_work_page');const rows=await sql()`SELECT id,document FROM claus_public_work WHERE published AND id>${after} ORDER BY id LIMIT ${limit}`;return {items:rows.map(r=>r.document),nextCursor:rows.length===limit?rows.at(-1)!.id:null,meaning:'Public work updates written by Claus, linked to successful public operations. Not an independent audit.'};}

export function productFindings(project:any,observation:any){
 if(!observation.available)return [{kind:(observation.error??observation.reason)==='not_found'?'not-public':'observation-unavailable',next:(observation.error??observation.reason)==='not_found'?'Inspect your project visibility and intended publication before deciding whether to publish it.':'Read the original project again later; do not infer removal or outage.'}];
 const value=observation.value,findings=[];
 if(!(value.interfaces??value.releases??[]).length)findings.push({kind:'no-published-interface',next:'Inspect the project purpose and existing snapshots; a service-only project may be intentional.'});
 if(!value.description?.trim())findings.push({kind:'missing-description',next:'Describe the actual available function after reading the current project.'});
 return findings;
}

async function runNetworkCare(args:any){
 if(args.action==='lessons')return operatingLessons();
 if(args.action==='diagnose'){if(typeof args.code!=='string'||args.code.length>160)throw Error('invalid_failure_code');return diagnoseFailure(args.code,args.uncertainWrite===true);}
 if(args.action==='lesson'){const incident=(await readNetworkIncidents(undefined,String(args.incidentId))).find((x:any)=>x.id===args.incidentId);if(incident?.state!=='recovered'||typeof args.reason!=='string'||!args.reason.trim()||args.reason.length>1000||!/^j_[1-9][0-9]*$/.test(args.evidence??''))throw Error('recovered_incident_and_evidence_required');const [e]=await sql()`SELECT id,kind,summary,data,visibility,created_at FROM claus_journal WHERE id::text=${args.evidence.slice(2)}`;if(!validWorkEvidence(e,'internal')||Date.parse(e.created_at)<Date.parse(incident.first_observed_at))throw Error('incident_evidence_unavailable');const previous=(await measurementHistory('lesson:'+incident.id))[0]?.document;if(previous?.reason===args.reason&&previous?.evidence===args.evidence&&previous?.recoveredAt===incident.recovered_at)return {saved:true,unchanged:true,incidentId:incident.id};await saveMeasurement('lesson:'+incident.id,{observedAt:Date.now(),incidentId:incident.id,reason:args.reason,evidence:args.evidence,recoveredAt:incident.recovered_at});return {saved:true,incidentId:incident.id};}
 if(args.action==='inspect')return network.call('public_project_check',{slug:args.slug});
 if(args.action==='recover'){const observation=await networkContext();const at=new Date().toISOString();await recordNetworkIncidents(observation,at);return {observedAt:at,observation,incidents:await readNetworkIncidents(),work:await networkOperations.read(),next:'Resume the original affected work only after checking these results. Reading a recovered endpoint does not prove an application defect is repaired. Preserve every uncertain write and payment id.'};}
 if(args.action==='measurements'){
  const sample=await network.call('app_metrics',{projectId:args.projectId}),comparison=await saveMeasurement('app:'+args.projectId,sample);
  return {sample,comparison,history:await measurementHistory('app:'+args.projectId)};
 }
 if(args.action==='plan'){
  const work=(await networkOperations.read(args.id)).items[0],wallet=await workWallet.tool({operation:'status'}),plan=costAssessment(args,work,wallet);
  await saveMeasurement('plan:'+args.id,plan);
  return {plan,existingWork:await networkOperations.read(),next:'Check overlapping work and deliverable usefulness before paying. Reuse existing tasks, commissions and reservations. This assessment grants no extra allowance.'};
 }

 if(args.action==='experiments'){
  const [experiments,builds]=await Promise.all([
   sql()`SELECT id,status,result->>'exitCode' AS exit_code,result->>'projectId' AS project_id,result->>'projectVersion' AS project_version,created_at,completed_at FROM claus_actions WHERE kind IN ('sandbox','development') ORDER BY created_at DESC LIMIT 20`,
   sql()`SELECT id,title,status,revision,summary,updated_at FROM claus_builds WHERE owner_scope='claus' ORDER BY updated_at DESC LIMIT 20`
  ]);
  return {observedAt:new Date().toISOString(),experiments,builds,scope:'Latest 20 recorded sandbox experiments and latest 20 own build records. Status is a stored execution record, not continuous activity. Completed experiments and registered agent profiles are not independently running children, public token launches or production deployments. Read the exact original record before making claims.'};
 }
 if(args.action==='products'){
  const snapshot=await observeProducts(network,args.after);
  if(!snapshot.available)return snapshot;
  return {...snapshot,items:snapshot.items!.map(({project:p,metrics,publicView,runtimes,inference,infrastructure}:any)=>({project:p,infrastructure,runtimes:runtimes?.available?runtimes.value:runtimes??{available:false},inference:inference?.available?inference.value:inference??{available:false},usage:metrics.available?metrics.value:{...metrics,reason:'unavailable'},publicState:publicView.available?{available:true,url:'https://claus.si/c/'+p.slug,description:publicView.value.description,interfaces:publicView.value.interfaces??publicView.value.releases??[],agents:publicView.value.agents??[],services:publicView.value.services??[],application:publicView.value.application??null}:publicView,inspection:productFindings(p,publicView)})),work:await networkOperations.read(),next:'Continue the original work. Missing reads are unknown. Registered agent profiles are not running children; usage counts records, not visitors.'};
 }

 if(args.action==='incidents')return {coverage:await operatingCoverage(),lessons:await Promise.all((await readNetworkIncidents()).map(async(x:any)=>({incidentId:x.id,lessons:await measurementHistory('lesson:'+x.id)}))),measurements:await measurementHistory('network'),items:await readNetworkIncidents(),scope:'Reader availability and isolated-worker overdue-lease observations. Two consecutive failures open one incident. Recovery means that specific signal cleared, not that the original job succeeded. Failed/unknown outcomes require original receipts; no automatic retry or fix claim.'};
 if(args.action==='economics'){const [wallet,resources]=await Promise.all([workWallet.tool({operation:'status'}),operatingResources()]);const history=await measurementHistory('wallet-forecast'),forecast=walletForecast(wallet,history[0]?.document);await saveMeasurement('wallet-forecast',forecast);const operation=operatingAssessment(resources,await measurementHistory('operating-budget'));if(operation.state!=='unknown')await saveMeasurement('operating-budget',operation);return {wallet,forecast,resources,operation,models:await new BuilderStore(productionLabDatabase()).usage('claus').catch(()=>({state:'unavailable'})),accounting:'ETH gas and principal, CLAUS principal, spent and unresolved reservations are separate. Wallet balance is not revenue; credit is not withdrawn income. Model spend is separately tracked by Builder usage, not this wallet.'};}
 if(args.action==='public')return publicWork({after:args.after});
 await initialize();
 if(!/^nw_[a-z0-9_-]{1,80}$/.test(args.id??''))throw Error('invalid_public_work_id');
 if(args.action==='withdraw'){const queued=(await networkReleaseFeed()).find(r=>r.id==='network-work-'+hash(args.id).slice(0,32));if(queued?.status==='queued')await withdrawNetworkRelease(queued.id);if(queued?.status==='dispatching')throw Error('public_work_announcement_in_flight');const rows=await sql()`UPDATE claus_public_work SET published=false,updated_at=now() WHERE id=${args.id} RETURNING id`;return {withdrawn:rows.length>0};}
 const work=(await networkOperations.read(args.id)).items[0];
 if(args.action==='publish'){
  const doc=validatePublicWork(args,work),refs=work.evidence.map((r:string)=>r.slice(2));
  const evidence=await sql()`SELECT id,kind,summary,data,visibility FROM claus_journal WHERE id::text=ANY(${refs}::text[])`;doc.evidence=publicWorkEvidence(work,evidence);
  const digest=hash(doc),old=(await sql()`SELECT * FROM claus_public_work WHERE id=${doc.id}`)[0];
  if(old?.work_revision===doc.revision&&old.hash!==digest)throw Error('public_work_revision_conflict');
  const rows=await sql()`INSERT INTO claus_public_work(id,work_revision,document,hash) VALUES(${doc.id},${doc.revision},${JSON.stringify(doc)}::jsonb,${digest}) ON CONFLICT(id) DO UPDATE SET work_revision=excluded.work_revision,document=excluded.document,hash=excluded.hash,published=true,updated_at=now() WHERE claus_public_work.work_revision<excluded.work_revision OR claus_public_work.hash=excluded.hash RETURNING document`;
  if(!rows.length)throw Error('public_work_revision_conflict');return {published:true,url:'https://claus.si/Work',work:rows[0].document};
 }
 if(args.action==='announce'){
  const row=(await sql()`SELECT * FROM claus_public_work WHERE id=${args.id} AND published`)[0];if(!row||row.document.status!=='completed'||work?.status!=='completed'||work.revision!==row.work_revision)throw Error('public_work_not_completed');
  const id='network-work-'+hash(args.id).slice(0,32),prior=(await networkReleaseFeed()).find(r=>r.id===id);if(prior)return {id,status:prior.status};
  for(const url of row.document.urls){const response=await fetch(url,{method:'HEAD',redirect:'error',signal:AbortSignal.timeout(8000)});if(!response.ok)throw Error('public_work_url_unavailable');}
  return enqueueNetworkRelease({id,text:args.text,sourceHash:row.hash,verifiedAt:new Date().toISOString(),urls:row.document.urls,facts:[row.document.summary,'Claus work assessment linked to public operation receipts.']});
 }
 throw Error('invalid_network_care_action');
}

export async function networkCare(args:any){try{return await runNetworkCare(args);}catch(e){return networkFailure(e,['publish','withdraw','announce','lesson','plan'].includes(args?.action),'network_care_'+args?.action);}}
