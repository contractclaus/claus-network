import {neon} from '@neondatabase/serverless';
import {authorized} from '../policy.js';
import {digest} from '../resources/store.mjs';
import {resourceProviders} from '../resources/providers.mjs';
import {resourceBudget} from '../resources/budget.mjs';
const repo='/repos/contractclaus/claus-network-recovery',workflow='claus-native-database.yml';
const fail=s=>{throw Error('database_recovery_'+s);};
const clean=s=>typeof s==='string'&&s.trim().length>0&&s.length<=1000&&!/-----BEGIN|Bearer\s|(?:token|secret|password)\s*[=:]\s*\S{8}/i.test(s);
const summarize=row=>row?{id:row.id,state:row.state,operation:row.record.operation,workId:row.record.workId,createdAt:row.created_at,updatedAt:row.updated_at,result:row.record.result??null,runId:row.record.runId??null,sourceCommit:row.record.sourceCommit,stage:row.record.stage??null,lastError:row.record.lastError??null}:null;
export function databaseRecovery({env=process.env,providers=resourceProviders(),budget=resourceBudget()}={}){
 const cfg=()=>JSON.parse(env.NATIVE_DATABASE_RECOVERY_ACCESS??'null')??fail('not_configured');
 const db=()=>neon(cfg().coordinatorUrl),source=()=>neon(cfg().sourceUrl);
 const gh=(p,o)=>providers.call('github',repo+p,o);
 async function original(id){if(!/^dbr_[a-f0-9]{24}$/.test(id??''))fail('id_invalid');const[r]=await db()`SELECT * FROM claus_recovery.attempts WHERE id=${id}`;if(!r)fail('not_found');return r;}
 async function reconcile(row){
  if(!row.record.sourceCommit)return row;
  let run;
  if(row.record.runId)run=await gh('/actions/runs/'+row.record.runId);
  else{const list=await gh('/actions/workflows/'+workflow+'/runs?event=workflow_dispatch&head_sha='+row.record.sourceCommit+'&per_page=100');const matches=list.workflow_runs.filter(x=>x.display_title==='Claus Native database ('+row.id+':'+(row.record.sequence??0)+')');if(matches.length>1)fail('duplicate_run');run=matches[0];}
  if(run){if(run.head_sha!==row.record.sourceCommit||run.display_title!=='Claus Native database ('+row.id+':'+(row.record.sequence??0)+')')fail('run_changed');
   await db()`UPDATE claus_recovery.attempts SET record=record||${JSON.stringify({runId:run.id,runState:run.status,runConclusion:run.conclusion})}::jsonb,updated_at=now() WHERE id=${row.id}`;
   await budget('commit',row.id,'1000000','service',row.record.sequence??0);
  }return original(row.id);
 }
 return {async call(operation,input={},requestId){
  if(!input||Array.isArray(input)||typeof input!=='object')fail('input_invalid');
  if(operation==='status'){
   const[control]=await db()`SELECT epoch,active_instance,phase,request_id,updated_at FROM claus_recovery.control WHERE id`;
   const[target]=await db()`SELECT claus_recovery.target_status() AS state`;
   let primary;try{primary=(await source()`SELECT claus_recovery.source_status() AS state`)[0].state;}catch{primary={unavailable:true};}
   return {control,target:target.state,primary,executor:env.NATIVE_DATABASE_RECOVERY_EXECUTOR,deployment:env.VERCEL_DEPLOYMENT_ID,providerIndependent:false,scope:'Native database in a separate Neon project and AWS region; other service databases and whole-provider failure remain separate dependencies.'};
  }
  if(operation==='result')return summarize(await reconcile(await original(input.id)));
  if(operation==='resume'){
   if(typeof requestId!=='string'||!/^[-a-zA-Z0-9_:]{1,160}$/.test(requestId))fail('request_invalid');
   let row=await original(input.id);
   if(row.record.resumeRequestId===requestId)return summarize(await reconcile(row));
   row=await reconcile(row);if(row.state!=='blocked'||row.record.runState!=='completed')fail('original_not_stopped');
   const sequence=(row.record.sequence??0)+1;await budget('reserve',row.id,'1000000','service',sequence);
   const record={...row.record,sequence,resumeRequestId:requestId,runId:null,runState:null,runConclusion:null,priorRuns:[...(row.record.priorRuns??[]),row.record.runId]};
   const updated=await db()`UPDATE claus_recovery.attempts SET state='dispatching',record=${JSON.stringify(record)}::jsonb,updated_at=now() WHERE id=${row.id} AND state='blocked' AND (record->>'sequence')::integer=${sequence-1} RETURNING id`;
   if(updated.length){try{await gh('/actions/workflows/'+workflow+'/dispatches',{method:'POST',body:{ref:'claus-native-database-'+record.sourceCommit,inputs:{requestId:row.id,continuation:String(sequence)}}});}catch{return {...summarize(await original(row.id)),dispatch:'unknown',retry:false};}}
   return summarize(await reconcile(await original(row.id)));
  }
  if(!['plan','cutover'].includes(operation)||typeof requestId!=='string'||!/^[-a-zA-Z0-9_:]{1,160}$/.test(requestId))fail('request_invalid');
  const id='dbr_'+digest(requestId).slice(0,24),inputHash=digest({operation,input});let[row]=await db()`SELECT * FROM claus_recovery.attempts WHERE id=${id}`;
  if(row){if(row.input_hash!==inputHash)fail('request_conflict');if(row.state!=='prepared')return summarize(await reconcile(row));}
  if(!row){
  let workId=input.workId;
  if(operation==='plan'){
   if(Object.keys(input).some(k=>!['workId','reason'].includes(k))||!/^nw_[a-z0-9_-]{1,80}$/.test(workId??'')||!clean(input.reason))fail('work_required');
   const[work]=await source()`SELECT claus_recovery.work_status(${workId}) AS status`;if(!['ready','working','waiting'].includes(work.status))fail('work_inactive');
  }else{
   if(Object.keys(input).some(k=>!['planId','expectedEpoch'].includes(k)))fail('input_invalid');const plan=await original(input.planId);
   if(plan.state!=='planned'||plan.record.operation!=='plan'||!Number.isSafeInteger(input.expectedEpoch)||Number(plan.record.result?.epoch)!==input.expectedEpoch)fail('plan_required');workId=plan.record.workId;
  }
  const commit=env.NATIVE_DATABASE_RECOVERY_EXECUTOR;if(!/^[a-f0-9]{40}$/.test(commit??''))fail('executor_unconfigured');
  const ref=await gh('/git/ref/tags/claus-native-database-'+commit);if(ref.object.sha!==commit)fail('executor_changed');
  await budget('reserve',id,'1000000','service');
  const record={operation,input,workId,sourceCommit:commit,originalRequestId:requestId,sequence:0};
  await db()`INSERT INTO claus_recovery.attempts(id,input_hash,state,record) VALUES(${id},${inputHash},'prepared',${JSON.stringify(record)}::jsonb) ON CONFLICT DO NOTHING`;
  }
  row=await original(id);if(row.input_hash!==inputHash)fail('request_conflict');
  const claimed=await db()`UPDATE claus_recovery.attempts SET state='dispatching',updated_at=now() WHERE id=${id} AND state='prepared' RETURNING id`;
  if(claimed.length){try{await gh('/actions/workflows/'+workflow+'/dispatches',{method:'POST',body:{ref:'claus-native-database-'+row.record.sourceCommit,inputs:{requestId:id,continuation:String(row.record.sequence??0)}}});}catch{return {...summarize(await original(id)),dispatch:'unknown',retry:false};}}
  return summarize(await reconcile(await original(id)));
 }};
}
export function installDatabaseRecovery(app,{env=process.env,service=databaseRecovery()}={}){
 app.post('/api/database-recovery',async c=>{
  c.header('Cache-Control','no-store');
  if(env.SERVICE_ROLE!=='operator'||env.PUBLISHER_ENABLED!=='true')return c.json({error:'database_recovery_disabled'},403);
  if(!authorized(c.req.header('authorization'),env.PUBLISHER_SECRET))return c.json({error:'unauthorized'},401);
  try{const raw=await c.req.text();if(Buffer.byteLength(raw)>8000)return c.json({error:'database_recovery_input_large'},413);const v=JSON.parse(raw);return c.json({result:await service.call(v.operation,v.input??{},v.requestId)});}
  catch(e){return c.json({error:/^database_recovery_[a-z_]+$/.test(e.message)?e.message:'database_recovery_unavailable',retry:false},409);}
 });
}
