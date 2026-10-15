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
  const row=(await q.query(`SELECT revision,deployment_id FROM claus_builder_deployment WHERE id${lock?' FOR SHARE':''}`)).rows[0];
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
 async pin(expectedRevision:number,deploymentId:string):Promise<BuilderDeployment>{
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||!/^dpl_[A-Za-z0-9]+$/.test(deploymentId))throw Error('builder_deployment_invalid');
  return this.db.transaction(async q=>{
   // Same order as claims/reservations. Publication must take this lock before
   // assertCurrent(q), so pinning cannot cross its commit boundary.
   await q.query('SELECT pg_advisory_xact_lock(6041010)');
   const current=await this.active(q,true);
   if((current?.revision??0)!==expectedRevision)throw Error('builder_deployment_conflict');
   // A sleeping/quota-wait workflow has released its lease. An active worker
   // must finish its dispatch/receipt boundary before the operator cuts over.
   if((await q.query("SELECT to_regclass('public.claus_builds') AS table_name")).rows[0]?.table_name&&
      (await q.query('SELECT id FROM claus_builds WHERE lease_until>now() LIMIT 1')).rows.length)throw Error('builder_deployment_busy');
   const revision=expectedRevision+1;
   await q.query(`INSERT INTO claus_builder_deployment(id,revision,deployment_id) VALUES(true,$1,$2)
    ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,deployment_id=EXCLUDED.deployment_id,updated_at=now()`,[revision,deploymentId]);
   return {revision,deploymentId};
  });
 }
}

// Parent-owned publication code calls this INSIDE its transaction, before any
// write. Holding the shared row lock makes the publication/pin order explicit.
export async function assertBuilderDeployment(q:LabQuery,deploymentId:()=>string|undefined=()=>process.env.VERCEL_DEPLOYMENT_ID){
 const db:LabDatabase={query:q.query.bind(q),transaction:fn=>fn(q)};
 await new BuilderCoordination(db,deploymentId).assertCurrent(q);
}
