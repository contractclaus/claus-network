import {createHash} from 'node:crypto';

export const canonicalProgramValue=value=>Array.isArray(value)?value.map(canonicalProgramValue):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonicalProgramValue(value[key])])):value;
export const programDigest=value=>createHash('sha256').update(JSON.stringify(canonicalProgramValue(value))).digest('hex');
const digest=programDigest;
export const programRunId=actionId=>'network-program-run:'+digest({actionId});
export const isProgramRun=id=>/^network-program-run:[a-f0-9]{64}$/.test(id??'');

export function validRecordedStep(row){
 const saved=row?.input;
 if(row?.kind!=='network_program'||!saved||typeof saved!=='object'||Array.isArray(saved))return false;
 const keys=['sourceHash','projectId','runId','index','operation','input','workId','workRevision'];
 if(Object.keys(saved).some(key=>!keys.includes(key)&&key!=='journalVersion')||keys.some(key=>!Object.hasOwn(saved,key)))return false;
 if(!/^[a-f0-9]{64}$/.test(saved.sourceHash)||!Number.isSafeInteger(saved.index)||saved.index<0||saved.index>3||
    typeof saved.projectId!=='string'||typeof saved.runId!=='string'||typeof saved.workId!=='string'||
    !Number.isSafeInteger(saved.workRevision)||saved.workRevision<1)return false;
 // Legacy JSONB rows lost property order. Their original identity/input is
 // protected by the database trigger; do not rewrite their historical hash.
 // New rows use canonical input for the stored hash and every comparison.
 return saved.journalVersion===undefined||saved.journalVersion===2&&programDigest(saved)===row.input_hash;
}

// The durable parent is admitted under both project and work locks. It remains
// present between steps and after a process exit; a lease timeout never clears it.
export async function admitProgramRun(db,id,input) {
 if(!isProgramRun(id))throw Error('network_program_identity_denied');
 return db.transaction(async q=>{
  for(const key of ['project:'+input.projectId,'work:'+input.workId].sort()){
   const lock=(await q.query('SELECT pg_try_advisory_xact_lock(6041038,hashtext($1)) AS acquired',[key])).rows[0];
   if(!lock?.acquired)return {state:'busy',id};
  }
  const old=(await q.query('SELECT * FROM claus_actions WHERE id=$1',[id])).rows[0];
  if(old){
   if(old.kind!=='network_program_run'||old.input_hash!==digest(input))throw Error('network_program_identity_denied');
   return {state:'existing',row:old};
  }
  const blocked=(await q.query(`SELECT id FROM claus_actions
   WHERE kind IN ('network_program','network_program_run') AND status NOT IN ('completed','failed')
   AND (input->>'projectId'=$1 OR input->>'workId'=$2) ORDER BY created_at,id LIMIT 1`,
   [input.projectId,input.workId])).rows[0];
  if(blocked)return {state:'held',id:blocked.id};
  const row=(await q.query(`INSERT INTO claus_actions(id,kind,input_hash,input,status,visibility)
   VALUES($1,'network_program_run',$2,$3::jsonb,'pending','private_network') RETURNING *`,
   [id,digest(input),JSON.stringify(input)])).rows[0];
  return {state:'admitted',row};
 });
}

// Only one executor may continue a parent. Connection loss releases the lock,
// but never removes the durable parent or a child's original API key.
export async function withProgramRun(db,id,execute) {
 return db.transaction(async q=>{
  const lock=(await q.query('SELECT pg_try_advisory_xact_lock(6041039,hashtext($1)) AS acquired',[id])).rows[0];
  if(!lock?.acquired)return {state:'waiting',success:false,originalRunId:id,reason:'original_run_active'};
  const alive=async()=>{await q.query('SELECT 1');};
  return execute(alive);
 });
}

export function runIsHeld(result,unresolvedSteps) {
 return unresolvedSteps.length>0||result?.reason==='original_action_requires_reconciliation';
}

// Parent completion and child admission share a row lock. Even a process that
// loses its execution connection cannot append a late step to a stopped run.
// The reservation commits before the existing once() starts the API call.
export async function reserveProgramStep(db,parentId,id,input) {
 return db.transaction(async q=>{
  const parent=(await q.query("SELECT * FROM claus_actions WHERE id=$1 AND kind='network_program_run' FOR UPDATE",[parentId])).rows[0];
  if(!parent||input.runId!==parentId||input.projectId!==parent.input.projectId||
     input.workId!==parent.input.workId||input.workRevision!==parent.input.expectedRevision||
     input.sourceHash!==parent.input.sourceHash||input.journalVersion!==2)throw Error('network_program_identity_denied');
  if(['completed','failed'].includes(parent.status)){
   const old=(await q.query('SELECT id FROM claus_actions WHERE id=$1',[id])).rows[0];
   if(old)return [];
   throw Error('network_program_parent_stopped');
  }
  return (await q.query(`INSERT INTO claus_actions(id,kind,input_hash,input,status,visibility)
   VALUES($1,'network_program',$2,$3::jsonb,'pending','private_network') ON CONFLICT DO NOTHING RETURNING id`,
   [id,digest(input),JSON.stringify(input)])).rows;
 });
}

export async function completeProgramRun(db,id,result) {
 return db.transaction(async q=>{
  const parent=(await q.query("SELECT status,result FROM claus_actions WHERE id=$1 AND kind='network_program_run' FOR UPDATE",[id])).rows[0];
  if(!parent)throw Error('network_program_identity_denied');
  if(['completed','failed'].includes(parent.status))return parent.result;
  const steps=(await q.query("SELECT id,status FROM claus_actions WHERE kind='network_program' AND input->>'runId'=$1 ORDER BY created_at,id",[id])).rows;
  const pending=steps.filter(step=>!['completed','failed'].includes(step.status));
  if(runIsHeld(result,pending)){
   const output={...result,state:'waiting',success:false,pendingSteps:pending.map(step=>step.id)};
   await q.query("UPDATE claus_actions SET progress=$2::jsonb WHERE id=$1",[id,JSON.stringify({result:output})]);
   return output;
  }
  await q.query("UPDATE claus_actions SET status='completed',result=$2::jsonb,completed_at=now() WHERE id=$1",[id,JSON.stringify(result)]);
  return result;
 });
}
