import type {LabDatabase} from '../lab-db.js';
import {OperationsHost} from './host.js';
// Only the current production deployment may adopt an exact, completed native
// release. It advances the execution fence between turns and retains every
// continuation, action ID, balance and schedule. No model-accessible pin tool.
export async function operationalHandoff(db:LabDatabase,host:OperationsHost,dispatch:(generation:number)=>Promise<string>,deployment=process.env.VERCEL_DEPLOYMENT_ID){
 if(!deployment||(await host.project('native')).targets?.production?.id!==deployment)return null;
 if(!(await db.query("SELECT to_regclass('public.claus_operations_handoffs') AS t")).rows[0]?.t)return null;
 const pending=await db.transaction(async q=>{
  await q.query('SELECT pg_advisory_xact_lock(6041010)');
  const c=(await q.query("SELECT * FROM claus_operations_control WHERE scope='native' FOR UPDATE")).rows[0];
  if(!c?.enabled||c.deployment!==deployment)return null;
  const r=(await q.query("SELECT * FROM claus_operations_releases WHERE scope='native' AND ((state='active' AND deployment->>'id'=$1) OR (state='rolled_back' AND base_deployment=$1)) ORDER BY updated_at DESC LIMIT 1",[deployment])).rows[0];
  if(!r||r.state==='active'&&r.proof?.passed!==true||r.state==='rolled_back'&&!r.proof?.rollback?.completedAt)return null;
  const id=r.id+':'+r.state;
  if((await q.query('SELECT id FROM claus_operations_handoffs WHERE id=$1',[id])).rows.length)return null;
  const config=(await q.query('SELECT content FROM claus_config ORDER BY revision DESC LIMIT 1')).rows[0]?.content;
  if(!config?.settings.enabled||!config?.settings.networkOperations?.enabled||!config?.policy.capabilities.networkBuild)return null;
  if((await q.query('SELECT id FROM claus_builds WHERE lease_until>now() LIMIT 1')).rows.length)return null;
  const fence=(await q.query('SELECT * FROM claus_builder_deployment WHERE id FOR UPDATE')).rows[0];
  const origin=r.state==='active'?r.base_deployment:r.deployment?.id;
  if(!fence||![origin,deployment].includes(fence.deployment_id))return null;
  const state=(await q.query("UPDATE claus_state SET generation=generation+1,updated_at=now() WHERE id=1 AND ((status='waiting' AND (lease_until IS NULL OR lease_until<now())) OR (status='waiting_for_effect' AND lease_until IS NULL AND lease_owner IS NULL)) AND NOT EXISTS(SELECT 1 FROM claus_x_poll WHERE lease_until>now()) RETURNING generation")).rows[0];
  if(!state)return null;
  if(fence.deployment_id!==deployment)await q.query('UPDATE claus_builder_deployment SET revision=revision+1,deployment_id=$1,updated_at=now() WHERE id',[deployment]);
  await q.query('INSERT INTO claus_operations_handoffs(id,release_id,origin_deployment,target_deployment,generation) VALUES($1,$2,$3,$4,$5)',[id,r.id,origin,deployment,state.generation]);
  return{id,generation:state.generation};
 });
 if(!pending)return null;
 // Dispatch outcome remains unknown if interrupted. The existing overdue-run
 // recovery eventually fences/resumes that generation; this never dispatches
 // the same handoff twice or clears a saved effect.
 let runId:string;
 try{runId=await dispatch(pending.generation);}catch{return{...pending,state:'dispatch_unknown'};}
 await db.query('UPDATE claus_operations_handoffs SET run_id=$2 WHERE id=$1 AND run_id IS NULL',[pending.id,runId]);
 return{...pending,state:'started',runId};
}
