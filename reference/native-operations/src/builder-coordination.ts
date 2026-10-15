import {managedDatabase,managedSchemaReady} from './database-schema.js';
import type {LabDatabase,LabQuery} from './lab-db.js';

export class BuilderDeploymentFence extends Error {
 constructor(readonly reason:'unpinned'|'stale'){super(`builder_deployment_${reason}`);}
}
export type BuilderDeployment={revision:number;deploymentId:string};

// Service/operator infrastructure only. Never expose pin() as a model tool.
// The local, non-deployment adapter may omit this optional migration. Once the
// table exists, every adapter fails closed until an operator pins a deployment.
export class BuilderCoordination {
 constructor(readonly db:LabDatabase,readonly deploymentId:()=>string|undefined=()=>process.env.VERCEL_DEPLOYMENT_ID){}
 async initialize(){if(managedDatabase())return managedSchemaReady();await this.db.query(`CREATE TABLE IF NOT EXISTS claus_builder_deployment(
  id boolean PRIMARY KEY DEFAULT true CHECK(id),revision integer NOT NULL CHECK(revision>0),
  deployment_id text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now())`);}
 async active(q:LabQuery=this.db,lock=false):Promise<BuilderDeployment|null>{
  if(!(await q.query("SELECT to_regclass('public.claus_builder_deployment') AS table_name")).rows[0]?.table_name)return null;
  const row=(await q.query('SELECT revision,deployment_id FROM claus_builder_deployment WHERE id')).rows[0];
  return row?{revision:Number(row.revision),deploymentId:row.deployment_id}:null;
 }
 async assertCurrent(q:LabQuery=this.db):Promise<void>{
  const deployment=this.deploymentId(),active=await this.active(q,true);
  if(!active){
   // Existing isolated tests/offline tools have no deployed identity. Production
   // must never silently use an uninitialized or unpinned fence.
   if(!deployment&&!(await q.query("SELECT to_regclass('public.claus_builder_deployment') AS table_name")).rows[0]?.table_name)return;
   throw new BuilderDeploymentFence('unpinned');
  }
  if(!deployment||active.deploymentId!==deployment)throw new BuilderDeploymentFence('stale');
 }
 async pin(_revision:number,_deploymentId:string):Promise<BuilderDeployment>{throw Error('builder_pin_operator_required');}
}

// Parent-owned publication code calls this INSIDE its transaction, before any
// write. The enclosing transaction holds the shared 6041010 advisory lock ordering.
export async function assertBuilderDeployment(q:LabQuery,deploymentId:()=>string|undefined=()=>process.env.VERCEL_DEPLOYMENT_ID){
 const db:LabDatabase={query:q.query.bind(q),transaction:fn=>fn(q)};
 await new BuilderCoordination(db,deploymentId).assertCurrent(q);
}
