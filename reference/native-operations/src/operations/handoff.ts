import type {LabDatabase} from '../lab-db.js';
import {OperationsHost} from './host.js';
import {fenceNextTurn} from './runtime-handoff.js';
// Only the current production deployment may adopt an exact, completed native
// release. The next-turn fence advances while the current lease may drain;
// execution changes only after that lease releases. No model-accessible pin tool.
export async function operationalHandoff(db:LabDatabase,host:OperationsHost,dispatch:(generation:number)=>Promise<string>,deployment=process.env.VERCEL_DEPLOYMENT_ID){
 if(!deployment||(await host.project('native')).targets?.production?.id!==deployment)return null;
 if(!(await db.query("SELECT to_regclass('public.claus_operations_handoffs') AS t")).rows[0]?.t)return null;
 const adopted=await host.adopt(deployment);if(!adopted)return null;
 const pending=await db.transaction(async q=>{
  await q.query('SELECT pg_advisory_xact_lock(6041010)');
  const c=(await q.query("SELECT * FROM claus_operations_control WHERE scope='native'")).rows[0];
  if(!c?.enabled||c.deployment!==deployment)return null;
  const r=(await q.query("SELECT * FROM claus_operations_releases WHERE scope='native' AND ((state='active' AND deployment->>'id'=$1) OR (state='rolled_back' AND base_deployment=$1)) ORDER BY updated_at DESC LIMIT 1",[deployment])).rows[0];
  if(!r||r.state==='active'&&r.proof?.passed!==true||r.state==='rolled_back'&&!r.proof?.rollback?.completedAt)return null;
  const id=r.id+':'+r.state;
  if((await q.query('SELECT id FROM claus_operations_handoffs WHERE id=$1',[id])).rows.length)return null;
  const config=(await q.query('SELECT content FROM claus_config ORDER BY revision DESC LIMIT 1')).rows[0]?.content;
  if(!config?.settings.enabled||!config?.settings.networkOperations?.enabled||!config?.policy.capabilities.networkBuild)return null;
  if((await q.query('SELECT id FROM claus_builds WHERE lease_until>now() LIMIT 1')).rows.length)return null;
  const fence=(await q.query('SELECT * FROM claus_builder_deployment WHERE id')).rows[0];
  const origin=r.state==='active'?r.base_deployment:r.deployment?.id;
  if(!fence||fence.deployment_id!==deployment)return null;
  const generation=await fenceNextTurn(q);
  if(!generation)return null;
  await q.query('INSERT INTO claus_operations_handoffs(id,release_id,origin_deployment,target_deployment,generation) VALUES($1,$2,$3,$4,$5)',[id,r.id,origin,deployment,generation]);
  return{id,generation};
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
