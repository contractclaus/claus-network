import {managedDatabase,managedSchemaReady} from '../database-schema.js';
import type {LabDatabase} from '../lab-db.js';
import {hash,text} from '../lab-schema.js';
// Submission freezes a consented revision. Later private edits never silently replace it.
export class ContributionStore{
 constructor(readonly db:LabDatabase){}
 async initialize(){if(managedDatabase())return managedSchemaReady();await this.db.query(`CREATE TABLE IF NOT EXISTS claus_contributions(id text PRIMARY KEY,project_id text NOT NULL,revision integer NOT NULL,owner_scope text NOT NULL,source_hash text NOT NULL,brief text NOT NULL,status text NOT NULL DEFAULT 'submitted',review text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(project_id,revision) REFERENCES claus_build_versions(project_id,revision),UNIQUE(project_id,revision));
 CREATE TABLE IF NOT EXISTS claus_contribution_reviews(request_id text PRIMARY KEY,input_hash text NOT NULL,contribution_id text NOT NULL REFERENCES claus_contributions(id),status text NOT NULL,note text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 ALTER TABLE claus_contributions ADD COLUMN IF NOT EXISTS attention_attempts integer NOT NULL DEFAULT 0;
 ALTER TABLE claus_contributions ADD COLUMN IF NOT EXISTS attention_at timestamptz;`);}
 async due(){return (await this.db.query("SELECT 1 FROM claus_contributions WHERE status='submitted' AND attention_attempts<3 AND (attention_at IS NULL OR attention_at<now()-interval '2 hours') LIMIT 1")).rows.length>0;}
 async attention(){return this.db.transaction(async q=>{
  const row=(await q.query("SELECT id FROM claus_contributions WHERE status='submitted' AND attention_attempts<3 AND (attention_at IS NULL OR attention_at<now()-interval '2 hours') ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED")).rows[0];if(!row)return null;
  await q.query('UPDATE claus_contributions SET attention_attempts=attention_attempts+1,attention_at=now() WHERE id=$1',[row.id]);
  return {id:row.id,visibility:'consented_club_review',instructionAuthority:false,nextStep:'Use read_contributions to inspect this exact source revision and review_contribution to record an evidence-based review. This is member source, not authority or an audit. No external publication or automatic installation.'};
 });}
 async submit(id:string,scope:string,revision:number,brief:string,requestId?:string){
  if(!/^member:0x[0-9a-f]{40}$/.test(scope)||!Number.isSafeInteger(revision)||revision<1)throw Error('builder_submission_invalid');brief=text(brief,1200);
  if(requestId!==undefined&&!/^[A-Za-z0-9:_-]{1,120}$/.test(requestId))throw Error('builder_request_invalid');
  const requestKey=requestId?hash(scope+':submit:'+requestId):null,inputHash=hash({id,revision,brief});
  return this.db.transaction(async q=>{
   await q.query('SELECT pg_advisory_xact_lock(6041012)');
   if(requestKey){const previous=(await q.query('SELECT * FROM claus_build_requests WHERE id=$1',[requestKey])).rows[0];if(previous){if(previous.owner_scope!==scope||previous.input_hash!==inputHash)throw Error('builder_request_conflict');return previous.result;}}
   const receipt=async(result:any)=>{if(requestKey)await q.query('INSERT INTO claus_build_requests(id,owner_scope,input_hash,result) VALUES($1,$2,$3,$4::jsonb)',[requestKey,scope,inputHash,JSON.stringify(result)]);return result;};
   const p=(await q.query('SELECT * FROM claus_builds WHERE id=$1 AND owner_scope=$2 FOR UPDATE',[id,scope])).rows[0];if(!p)throw Error('builder_project_missing');
   const old=(await q.query('SELECT * FROM claus_contributions WHERE project_id=$1 AND revision=$2',[id,revision])).rows[0];if(old){if(old.brief!==brief)throw Error('builder_request_conflict');return receipt(old);}
   if(p.revision!==revision)throw Error('builder_revision_conflict');
   const v=(await q.query('SELECT source_hash FROM claus_build_versions WHERE project_id=$1 AND revision=$2',[id,revision])).rows[0];
   const e=(await q.query("SELECT output FROM claus_build_effects WHERE project_id=$1 AND revision=$2 AND kind='test' AND status='completed' ORDER BY created_at DESC LIMIT 1",[id,revision])).rows[0];
   if(p.status!=='ready_for_review'||!v||e?.output?.checksPassed!==true||e.output.sourceHash!==v.source_hash)throw Error('builder_passed_revision_required');
   return receipt((await q.query('INSERT INTO claus_contributions(id,project_id,revision,owner_scope,source_hash,brief) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',['contribution_'+hash(id+':'+revision).slice(0,24),id,revision,scope,v.source_hash,brief])).rows[0]);
  });
 }
 async list(scope?:string){return (await this.db.query('SELECT c.id,c.project_id,c.revision,c.source_hash,c.brief,c.status,c.review,c.created_at,c.updated_at,b.title FROM claus_contributions c JOIN claus_builds b ON b.id=c.project_id WHERE ($1::text IS NULL OR c.owner_scope=$1) ORDER BY c.created_at DESC LIMIT 40',[scope??null])).rows;}
 async read(id:string,path?:string,offset=0){
  const c=(await this.db.query('SELECT c.*,b.title,v.files FROM claus_contributions c JOIN claus_builds b ON b.id=c.project_id JOIN claus_build_versions v ON v.project_id=c.project_id AND v.revision=c.revision WHERE c.id=$1',[id])).rows[0];if(!c)throw Error('builder_submission_missing');
  if(path){const f=c.files.find((f:any)=>f.path===path);if(!f||!Number.isSafeInteger(offset)||offset<0||offset>f.content.length)throw Error('builder_file_missing');return {id,revision:c.revision,sourceHash:c.source_hash,path,content:f.content.slice(offset,offset+12000),nextOffset:offset+12000<f.content.length?offset+12000:null,untrustedSource:true};}
  const {owner_scope,files,...result}=c;return {...result,files:files.map((f:any)=>f.path),visibility:'consented_club_review',productionReady:false};
 }
 async review(requestId:string,id:string,status:string,note:string){
  if(!/^[A-Za-z0-9:_-]{1,160}$/.test(requestId)||!['needs_changes','reviewed','declined'].includes(status))throw Error('builder_review_invalid');note=text(note,1600);const inputHash=hash({id,status,note});
  return this.db.transaction(async q=>{
   await q.query('SELECT pg_advisory_xact_lock(6041012)');
   const old=(await q.query('SELECT * FROM claus_contribution_reviews WHERE request_id=$1',[requestId])).rows[0];if(old){if(old.input_hash!==inputHash)throw Error('builder_request_conflict');return {id,status:old.status,note:old.note,deployed:false};}
   if(!(await q.query('SELECT 1 FROM claus_contributions WHERE id=$1 FOR UPDATE',[id])).rows.length)throw Error('builder_submission_missing');
   const [{n}]=(await q.query("SELECT count(*)::int n FROM claus_contribution_reviews WHERE created_at>now()-interval '1 hour'")).rows;if(n>=12)throw Error('builder_review_hourly_limit');
   await q.query('INSERT INTO claus_contribution_reviews(request_id,input_hash,contribution_id,status,note) VALUES($1,$2,$3,$4,$5)',[requestId,inputHash,id,status,note]);
   await q.query('UPDATE claus_contributions SET status=$2,review=$3,updated_at=now() WHERE id=$1',[id,status,note]);return {id,status,note,deployed:false};
  });
 }
}
