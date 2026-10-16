import type {LabQuery} from './lab-db.js';

// Read-only handoff decision at a finished turn boundary. Existing generation,
// leases, original effects and workflow history are retained.
export async function runtimeContinuationTarget(db:LabQuery,generation:number,deployment=process.env.VERCEL_DEPLOYMENT_ID):Promise<string|null>{
 if(!deployment)return null;
 try{
  const row=(await db.query(`SELECT s.generation,s.lease_owner,s.lease_until,
   c.enabled,c.deployment,b.deployment_id,now() AS observed_at
   FROM claus_state s CROSS JOIN claus_builder_deployment b
   JOIN claus_operations_control c ON c.scope='native' WHERE s.id=1 AND b.id`)).rows[0];
  if(!row||row.generation!==generation||!row.enabled||row.deployment!==row.deployment_id||
    !/^dpl_[A-Za-z0-9]+$/.test(row.deployment)||row.deployment===deployment||
    row.lease_owner&&new Date(row.lease_until).getTime()>new Date(row.observed_at).getTime())return null;
  return row.deployment;
 }catch{return null;} // A read outage never changes execution rights or kills a healthy turn.
}
