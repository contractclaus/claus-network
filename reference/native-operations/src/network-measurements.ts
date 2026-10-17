import {managedDatabase,managedSchemaReady} from './database-schema.js';
import {sql} from './store.js';

let initialized:Promise<unknown>|undefined;
export function initializeMeasurements(){if(managedDatabase())return managedSchemaReady();return initialized??=sql()`CREATE TABLE IF NOT EXISTS claus_network_measurements(id bigserial PRIMARY KEY,subject text NOT NULL,observed_at timestamptz NOT NULL DEFAULT now(),document jsonb NOT NULL)`.catch(e=>{initialized=undefined;throw e;});}
export function compareMeasurements(previous:any,current:any){
 const fields=['readLatencyMs','successfulMutationsToday','storedRecordsAndTasks','membershipRecords','retainedEvents'];
 const sameDay=previous&&Math.floor(previous.observedAt/86400000)===Math.floor(current.observedAt/86400000),deltas:any={};
 for(const field of fields){const before=previous?.[field],after=current[field];if(typeof before==='number'&&typeof after==='number'&&(field!=='successfulMutationsToday'||sameDay)&&(field==='readLatencyMs'||after>=before))deltas[field]=after-before;}
 return {previousAt:previous?.observedAt??null,currentAt:current.observedAt,deltas,scope:'Observed managed-app counters; not visitors, independent users, revenue or causal proof of an improvement.'};
}
export async function saveMeasurement(subject:string,document:any){
 await initializeMeasurements();
 const rows=await sql()`SELECT document FROM claus_network_measurements WHERE subject=${subject} ORDER BY id DESC LIMIT 1`;
 if(subject==='operating-budget'&&Number.isFinite(rows[0]?.document?.observedAt)&&document.observedAt-rows[0].document.observedAt<1800000)return compareMeasurements(rows[0].document,document);
 await sql()`INSERT INTO claus_network_measurements(subject,document) VALUES(${subject},${JSON.stringify(document)}::jsonb)`;
 // Network observations need an actual multi-day history. Other potentially
 // large/private subjects keep their existing bounded count. Never rewrite rows.
 if(subject==='network'||subject==='operating-budget')await sql()`DELETE FROM claus_network_measurements WHERE subject=${subject} AND observed_at<now()-interval '8 days'`;
 else await sql()`DELETE FROM claus_network_measurements WHERE subject=${subject} AND id NOT IN (SELECT id FROM claus_network_measurements WHERE subject=${subject} ORDER BY id DESC LIMIT 90)`;
 return compareMeasurements(rows[0]?.document,document);
}
export async function measurementHistory(subject:string){
 await initializeMeasurements();return sql()`SELECT observed_at,document FROM claus_network_measurements WHERE subject=${subject} ORDER BY id DESC LIMIT 30`;
}
export function costAssessment(input:any,work:any,wallet:any){
 if(!work||work.id!==input.id||work.revision!==input.expectedRevision)throw Error('network_work_revision_conflict');
 if(!['ETH','CLAUS'].includes(input.asset)||typeof input.amountUnits!=='string'||!/^(0|[1-9][0-9]{0,77})$/.test(input.amountUnits)||typeof input.modelCostUsd!=='number'||!Number.isFinite(input.modelCostUsd)||input.modelCostUsd<0||input.modelCostUsd>500||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>1000)throw Error('invalid_cost_assessment');
 const account=wallet?.account,token=input.asset==='CLAUS',balance=token?wallet?.claus?.balanceUnits:wallet?.balanceWei,cap=token?wallet?.claus?.policy?.principal:wallet?.policy?.principal,perJob=token?wallet?.claus?.policy?.perJob:wallet?.policy?.perJob;
 const spent=token?account?.claus_spent:account?.principal_spent,reserved=token?account?.claus_reserved:account?.principal_reserved;
 const available=typeof balance==='string'&&typeof cap==='string'&&typeof spent==='string'&&typeof reserved==='string'?([BigInt(balance)-BigInt(reserved),BigInt(cap)-BigInt(spent)-BigInt(reserved)].reduce((a,b)=>a<b?a:b)):null;
 return {workId:work.id,workRevision:work.revision,asset:input.asset,amountUnits:input.amountUnits,modelCostUsd:input.modelCostUsd,reason:input.reason,availableUnits:available===null?null:String(available>0n?available:0n),principalFits:available!==null&&typeof perJob==='string'?BigInt(input.amountUnits)<=available&&BigInt(input.amountUnits)<=BigInt(perJob):null,observedAt:Date.now(),authority:'Planning only; no funds reserved or signing rights granted. Model budget and ETH gas must still pass their actual runtime checks.'};
}


export const observationWindowMs=7*86400000;
export function observationCoverage(rows:any[],now=Date.now(),readComplete=true){
 const from=now-observationWindowMs,maximumGapMs=30*60000;
 const samples=rows.map(row=>({at:Date.parse(row.observed_at),value:row.document})).filter(row=>Number.isFinite(row.at)&&row.at<=now&&row.at>=from-maximumGapMs).sort((a,b)=>a.at-b.at);
 const first=samples[0]?.at??null,last=samples.at(-1)?.at??null;
 const gaps=[] as {from:number;to:number;durationMs:number}[];
 let previous=from;
 for(const row of samples){if(row.at>previous&&row.at-previous>maximumGapMs)gaps.push({from:previous,to:row.at,durationMs:row.at-previous});previous=Math.max(previous,row.at);}
 if(now-previous>maximumGapMs)gaps.push({from:previous,to:now,durationMs:now-previous});
 const current=samples.filter(row=>row.at>=from),legacy=current.filter(row=>row.value?.coverageVersion!==1).length;
 const unavailable=current.filter(row=>['inventoryStatus','capabilitiesStatus','operationsStatus'].some(k=>row.value?.[k]!=='available')).length;
 const executionUnknown=current.filter(row=>row.value?.execution?.state!=='observed').length;
 const overdue=current.filter(row=>Number(row.value?.execution?.overdueLeases)>0).length;
 const workerUnknown=current.filter(row=>!Array.isArray(row.value?.workers)||!row.value.workers.length||row.value.workers.some((w:any)=>w.status!=='recent')).length;
 return {profile:'sampled-operating-evidence/1',observedAt:now,requestedFrom:from,requestedTo:now,samples:current.length,firstObservedAt:first,lastObservedAt:last,readComplete,maximumExpectedGapMs:maximumGapMs,gapCount:gaps.length,gaps:gaps.slice(0,8),continuousSevenDaySampling:readComplete&&first!==null&&first<=from&&last!==null&&now-last<=maximumGapMs&&gaps.length===0,
  legacySamples:legacy,unavailableReaderSamples:unavailable,incompleteExecutionSamples:executionUnknown,overdueWorkerSamples:overdue,incompleteWorkerSamples:workerUnknown,
  meaning:'Dated reader and execution observations, not continuous uptime, independent use, completed work, or autonomous recovery proof. Gaps and legacy evidence remain unknown.'};
}
export async function operatingCoverage(){
 await initializeMeasurements();
 const rows=await sql()`SELECT observed_at,document,count(*) OVER()::int AS total FROM claus_network_measurements WHERE subject='network' AND observed_at>=now()-interval '8 days' ORDER BY observed_at DESC,id DESC LIMIT 2048`;
 return observationCoverage(rows,Date.now(),rows.length===0||Number(rows[0].total)<=rows.length);
}
