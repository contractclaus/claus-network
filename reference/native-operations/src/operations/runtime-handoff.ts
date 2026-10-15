import type {LabDatabase,LabQuery} from '../lab-db.js';
import type {OperationsHost} from './host.js';
import {hash} from './policy.js';

// Advance the next-turn fence without interrupting the current lease holder.
// The old turn retains its memory/effect checkpoint and releases normally;
// acquire() will then accept only the new generation. No lease is cleared.
export async function fenceNextTurn(q:LabQuery,expected?:number){
 const {rows}=await q.query(`UPDATE claus_state SET generation=generation+1,updated_at=now()
 WHERE id=1 AND ($1::integer IS NULL OR generation=$1) AND (
  (status='working' AND lease_owner IS NOT NULL AND lease_until>now()) OR
  (status IN ('waiting','waiting_for_effect') AND lease_owner IS NULL AND lease_until IS NULL)
 ) RETURNING generation`,[expected??null]);
 return rows[0]?.generation as number|undefined;
}

export const handoffColumns=`ALTER TABLE claus_operations_handoffs ADD COLUMN IF NOT EXISTS request_hash text;
 ALTER TABLE claus_operations_handoffs ADD COLUMN IF NOT EXISTS dispatch_state text;
 ALTER TABLE claus_operations_handoffs ADD COLUMN IF NOT EXISTS observed_at timestamptz;
 ALTER TABLE claus_operations_handoffs ADD COLUMN IF NOT EXISTS observed_turn text;`;

export async function readRuntimeHandoff(db:LabQuery,id:string){
 if(typeof id!=='string'||!/^[A-Za-z0-9:_-]{1,160}$/.test(id))throw Error('runtime_handoff_id_invalid');
 const row=(await db.query(`SELECT id,release_id,origin_deployment,target_deployment,generation,run_id,
 dispatch_state,created_at,observed_at,observed_turn FROM claus_operations_handoffs WHERE id=$1`,[id])).rows[0];
 return row?{...row,state:row.observed_at?'observed':row.dispatch_state??(row.run_id?'started':'dispatch_unknown')}:null;
}

export async function ownerRuntimeHandoff(db:LabDatabase,host:OperationsHost,dispatch:(generation:number)=>Promise<string>,input:{id:string;expectedGeneration:number;targetDeployment:string},deployment=process.env.VERCEL_DEPLOYMENT_ID){
 if(typeof input.id!=='string'||!/^[A-Za-z0-9:_-]{1,140}$/.test(input.id)||!Number.isSafeInteger(input.expectedGeneration)||input.expectedGeneration<1)throw Error('runtime_handoff_request_invalid');
 if(!deployment||input.targetDeployment!==deployment||(await host.project('native')).targets?.production?.id!==deployment)throw Error('runtime_handoff_production_changed');
 const id='owner:'+input.id,requestHash=hash({id:input.id,expectedGeneration:input.expectedGeneration,targetDeployment:input.targetDeployment});
 const pending=await db.transaction(async q=>{
  await q.query('SELECT pg_advisory_xact_lock(6041010)');
  const existing=(await q.query('SELECT * FROM claus_operations_handoffs WHERE id=$1',[id])).rows[0];
  if(existing){if(existing.request_hash!==requestHash)throw Error('runtime_handoff_id_conflict');return null;}
  const config=(await q.query('SELECT content FROM claus_config ORDER BY revision DESC LIMIT 1')).rows[0]?.content;
  if(!config?.settings.enabled)throw Error('runtime_handoff_disabled');
  const pin=(await q.query("SELECT * FROM claus_operations_control WHERE scope='native' FOR UPDATE")).rows[0];
  if(!pin?.enabled||pin.deployment!==deployment)throw Error('runtime_handoff_pin_changed');
  const generation=await fenceNextTurn(q,input.expectedGeneration);
  if(!generation)throw Error('runtime_handoff_busy_disabled_or_superseded');
  await q.query(`INSERT INTO claus_operations_handoffs(id,release_id,origin_deployment,target_deployment,generation,request_hash,dispatch_state)
   VALUES($1,$2,$3,$4,$5,$6,'reserved')`,[id,id,'unobserved:generation:'+input.expectedGeneration,deployment,generation,requestHash]);
  return generation;
 });
 if(pending!==null){
  // Persist the attempt before dispatch. An uncertain start is never replayed
  // under a new ID. Existing overdue-generation recovery remains responsible.
  await db.query("UPDATE claus_operations_handoffs SET dispatch_state='dispatching' WHERE id=$1",[id]);
  try{
   const runId=await dispatch(pending);
   await db.query("UPDATE claus_operations_handoffs SET run_id=$2,dispatch_state='started' WHERE id=$1 AND run_id IS NULL",[id,runId]);
  }catch{await db.query("UPDATE claus_operations_handoffs SET dispatch_state='dispatch_unknown' WHERE id=$1 AND run_id IS NULL",[id]);}
 }
 return readRuntimeHandoff(db,id);
}

export async function observeRuntimeHandoff(db:LabQuery,generation:number,turn:string,deployment=process.env.VERCEL_DEPLOYMENT_ID){
 if(!deployment)return [];
 const {rows}=await db.query(`UPDATE claus_operations_handoffs h SET observed_at=now(),observed_turn=$3
 WHERE h.generation=$1 AND h.target_deployment=$2 AND h.observed_at IS NULL
 AND EXISTS(SELECT 1 FROM claus_state s WHERE s.id=1 AND s.generation=$1 AND s.lease_owner=$3 AND s.lease_until>now())
 RETURNING id,generation,target_deployment,observed_at`,[generation,deployment,turn]);
 return rows;
}
