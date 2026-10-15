import {managedDatabase,managedSchemaReady} from '../database-schema.js';
import type {LabDatabase} from '../lab-db.js';
import {hash,text} from '../lab-schema.js';
import {EMPTY_SITE,validateSite} from './schema.js';
import {undoSiteChange} from './coordination.js';
import {assertBuilderDeployment} from '../builder-coordination.js';
export class SiteStore{
 constructor(readonly db:LabDatabase,readonly deploymentId:()=>string|undefined=()=>process.env.VERCEL_DEPLOYMENT_ID){}
 async initialize(){if(managedDatabase())return managedSchemaReady();await this.db.query(`CREATE TABLE IF NOT EXISTS claus_site_versions(revision bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,request_id text UNIQUE NOT NULL,input_hash text NOT NULL,manifest jsonb NOT NULL,reason text NOT NULL,actor text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS claus_site_control(id boolean PRIMARY KEY DEFAULT true CHECK(id),revision bigint REFERENCES claus_site_versions(revision),enabled boolean NOT NULL DEFAULT false);
 INSERT INTO claus_site_control(id) VALUES(true) ON CONFLICT DO NOTHING;`);}
 async control(enabled:boolean){if(typeof enabled!=='boolean')throw Error('site_invalid_control');await this.db.query('UPDATE claus_site_control SET enabled=$1 WHERE id',[enabled]);return this.current();}
 async current(){const r=(await this.db.query('SELECT c.enabled,v.revision,v.manifest,v.created_at FROM claus_site_control c LEFT JOIN claus_site_versions v ON v.revision=c.revision WHERE c.id')).rows[0];return {revision:Number(r?.revision??0),enabled:r?.enabled===true,manifest:validateSite(r?.manifest??EMPTY_SITE),updatedAt:r?.created_at??null};}
 async history(){return (await this.db.query('SELECT revision::text,reason,actor,created_at FROM claus_site_versions ORDER BY revision DESC LIMIT 30')).rows;}
 async version(revision:number){if(!Number.isSafeInteger(revision)||revision<0)throw Error('site_invalid_revision');if(revision===0)return validateSite(EMPTY_SITE);const row=(await this.db.query('SELECT manifest FROM claus_site_versions WHERE revision=$1',[revision])).rows[0];if(!row)throw Error('site_revision_missing');return validateSite(row.manifest);}
 async apply(requestId:string,expectedRevision:number,manifest:unknown,reason:string,actor='claus',rollbackRevision?:number){
  if(!/^[a-zA-Z0-9:_-]{1,160}$/.test(requestId)||!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw Error('site_invalid_request');
  reason=text(reason,240);let validated=rollbackRevision===undefined?validateSite(manifest):undefined;
  if(rollbackRevision!==undefined&&(!Number.isSafeInteger(rollbackRevision)||rollbackRevision<0))throw Error('site_invalid_revision');
  const inputHash=hash({expectedRevision,manifest:validated??null,reason,actor,rollbackRevision:rollbackRevision??null});
  return this.db.transaction(async q=>{
   if(actor==='claus')await q.query('SELECT pg_advisory_xact_lock(6041010)');
   const control=(await q.query('SELECT * FROM claus_site_control WHERE id FOR UPDATE')).rows[0];
   const old=(await q.query('SELECT revision,manifest FROM claus_site_versions WHERE request_id=$1 AND input_hash=$2',[requestId,inputHash])).rows[0];if(old)return {revision:Number(old.revision),manifest:validateSite(old.manifest),published:true,replayed:true};
   if((await q.query('SELECT 1 FROM claus_site_versions WHERE request_id=$1',[requestId])).rows.length)throw Error('site_request_conflict');
   if(actor==='claus')await assertBuilderDeployment(q,this.deploymentId);
   if(!control?.enabled)throw Error('site_disabled');if(Number(control.revision??0)!==expectedRevision)throw Error('site_revision_conflict');
   if(actor==='claus'&&rollbackRevision!==undefined)throw Error('site_use_selective_undo');
   const [{n}]=(await q.query("SELECT count(*)::int n FROM claus_site_versions WHERE actor='claus' AND created_at>now()-interval '1 hour'")).rows;if(actor==='claus'&&rollbackRevision===undefined&&n>=6)throw Error('site_hourly_limit');
   if(rollbackRevision!==undefined){if(rollbackRevision===0)validated=validateSite(EMPTY_SITE);else{const row=(await q.query('SELECT manifest FROM claus_site_versions WHERE revision=$1',[rollbackRevision])).rows[0];if(!row)throw Error('site_revision_missing');validated=validateSite(row.manifest);}}
   const row=(await q.query('INSERT INTO claus_site_versions(request_id,input_hash,manifest,reason,actor) VALUES($1,$2,$3::jsonb,$4,$5) RETURNING revision',[requestId,inputHash,JSON.stringify(validated),reason,actor])).rows[0];
   await q.query('UPDATE claus_site_control SET revision=$1 WHERE id',[row.revision]);return {revision:Number(row.revision),manifest:validated!,published:true,replayed:false};
  });
 }
 async undo(requestId:string,expectedRevision:number,changeRevision:number,reason:string,channel:'public'|'club'='club'){
  if(!/^[a-zA-Z0-9:_-]{1,160}$/.test(requestId)||!Number.isSafeInteger(expectedRevision)||expectedRevision<1||!Number.isSafeInteger(changeRevision)||changeRevision<1||changeRevision>expectedRevision||!['public','club'].includes(channel))throw Error('site_invalid_request');
  reason=text(reason,240);const inputHash=hash({operation:'undo',expectedRevision,changeRevision,reason,channel});
  return this.db.transaction(async q=>{
   await q.query('SELECT pg_advisory_xact_lock(6041010)');
   const control=(await q.query('SELECT * FROM claus_site_control WHERE id FOR UPDATE')).rows[0];
   const old=(await q.query('SELECT revision,manifest,input_hash FROM claus_site_versions WHERE request_id=$1',[requestId])).rows[0];
   if(old){if(old.input_hash!==inputHash)throw Error('site_request_conflict');return {revision:Number(old.revision),manifest:validateSite(old.manifest),published:true,replayed:true};}
   await assertBuilderDeployment(q,this.deploymentId);
   if(!control?.enabled)throw Error('site_disabled');if(Number(control.revision??0)!==expectedRevision)throw Error('site_revision_conflict');
   const change=(await q.query('SELECT actor,manifest FROM claus_site_versions WHERE revision=$1',[changeRevision])).rows[0];
   if(change?.actor!=='claus')throw Error('site_undo_not_own_change');
   const before=(await q.query('SELECT manifest FROM claus_site_versions WHERE revision<$1 ORDER BY revision DESC LIMIT 1',[changeRevision])).rows[0];
   const later=(await q.query('SELECT manifest FROM claus_site_versions WHERE revision>$1 AND revision<=$2 ORDER BY revision',[changeRevision,expectedRevision])).rows.map(r=>validateSite(r.manifest));
   const after=validateSite(change.manifest),current=later.at(-1)??after;
   const manifest=undoSiteChange(validateSite(before?.manifest??EMPTY_SITE),after,current,later,channel);
   const row=(await q.query("INSERT INTO claus_site_versions(request_id,input_hash,manifest,reason,actor) VALUES($1,$2,$3::jsonb,$4,'claus') RETURNING revision",[requestId,inputHash,JSON.stringify(manifest),reason])).rows[0];
   await q.query('UPDATE claus_site_control SET revision=$1 WHERE id',[row.revision]);
   return {revision:Number(row.revision),manifest,published:true,replayed:false};
  });
 }
}
