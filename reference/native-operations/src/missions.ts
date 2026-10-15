import {sql} from './store.js';

export function validateMission(id:unknown,body:unknown,allowChainWrite:unknown=false) {
  if(typeof id!=='string'||!/^[a-zA-Z0-9_.:-]{1,160}$/.test(id)||typeof body!=='string'||!body.trim()||body.length>16000||typeof allowChainWrite!=='boolean')throw Error('invalid_owner_mission');
}
export async function assignMission(id:string,body:string,allowChainWrite=false) {
  validateMission(id,body,allowChainWrite);
  throw Error('owner_mission_managed_externally');
}
export async function activeMissions() {
  return sql()`SELECT id,body,chain_write,created_at FROM claus_missions WHERE status='active' ORDER BY created_at LIMIT 8`;
}
export function hasWriteMission(missions:{chain_write?:boolean}[]) {return missions.some(m=>m.chain_write===true);}
export async function finishMission(id:string,result:string) {
  if(typeof result!=='string'||!result.trim()||result.length>8000)throw Error('invalid_mission_result');
  const rows=await sql()`UPDATE claus_missions SET status='completed',result=${result},completed_at=now() WHERE id=${id} AND status='active' RETURNING id,status`;
  return rows[0]??{error:'active_mission_not_found'};
}
