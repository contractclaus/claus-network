import {managedDatabase,managedSchemaReady} from '../database-schema.js';
import type {LabDatabase} from '../lab-db.js';
import {hash,text} from '../lab-schema.js';
// A weekly attention signal reuses CLAUS's existing leased Club turn. It never
// buys another model call, synthesizes a conversation or alters owner policy.
export class ContinuityStore{
 constructor(readonly db:LabDatabase){}
 async initialize(){if(managedDatabase())return managedSchemaReady();await this.db.query(`CREATE TABLE IF NOT EXISTS claus_ecosystem_clock(id boolean PRIMARY KEY DEFAULT true CHECK(id),next_at timestamptz NOT NULL DEFAULT now()+interval '7 days',attention_at timestamptz,attention_attempts integer NOT NULL DEFAULT 0);
 INSERT INTO claus_ecosystem_clock(id) VALUES(true) ON CONFLICT DO NOTHING;
 CREATE TABLE IF NOT EXISTS claus_ecosystem_recaps(period text PRIMARY KEY,input_hash text NOT NULL,draft jsonb NOT NULL,status text NOT NULL DEFAULT 'prepared',receipt jsonb,created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz);`);}
 async due(){return (await this.db.query("SELECT 1 FROM claus_ecosystem_clock WHERE id AND next_at<=now() AND attention_attempts<3 AND (attention_at IS NULL OR attention_at<now()-interval '2 hours')")).rows.length>0;}
 async context(mark=false){
  const row=(await this.db.query('SELECT * FROM claus_ecosystem_clock WHERE id')).rows[0];if(!row||new Date(row.next_at).getTime()>Date.now())return {due:false,nextAt:row?.next_at??null};
  const period=new Date(row.next_at).toISOString(),since=new Date(new Date(row.next_at).getTime()-7*86400000).toISOString();
  if(mark)await this.db.query("UPDATE claus_ecosystem_clock SET attention_at=now(),attention_attempts=attention_attempts+1 WHERE id AND next_at<=now() AND (attention_at IS NULL OR attention_at<now()-interval '2 hours')");
  const draft=(await this.db.query('SELECT draft,status FROM claus_ecosystem_recaps WHERE period=$1',[period])).rows[0];
  const work=(await this.db.query("SELECT id,revision,status,content->>'title' AS title,left(content->>'nextStep',400) AS next_step FROM claus_lab_ideas WHERE visibility='public' AND updated_at>=$1 AND updated_at<$2 ORDER BY updated_at DESC LIMIT 12",[since,period])).rows;
  const ownBuilds=(await this.db.query("SELECT id,revision,status,title,summary FROM claus_builds WHERE owner_scope='claus' AND updated_at>=$1 AND updated_at<$2 ORDER BY updated_at DESC LIMIT 6",[since,period])).rows;
  const contributions=(await this.db.query("SELECT status,count(*)::int AS count FROM claus_contributions WHERE created_at>=$1 AND created_at<$2 GROUP BY status",[since,period])).rows;
  return {due:true,period,since,work,ownBuilds,contributions,prepared:draft?.draft??null,visibility:'private_club',instructionAuthority:false,meaning:'Prepare a brief weekly Club update from these actual records. Research/checks are not shipped features. Skip filler, acknowledge unresolved work, and record one useful process lesson with remember. Private member work is represented only by aggregate counts. Use publish_weekly_recap; it saves one update with a stable receipt. Do not post this on X.'};
 }
 async prepare(period:string,value:any){
  if(typeof period!=='string'||!Number.isFinite(Date.parse(period)))throw Error('ecosystem_recap_invalid');
  const draft={title:text(value.title,120),body:text(value.body,1800)},inputHash=hash(draft);
  return this.db.transaction(async q=>{
   const old=(await q.query('SELECT * FROM claus_ecosystem_recaps WHERE period=$1',[period])).rows[0];if(old)return old;
   const clock=(await q.query('SELECT * FROM claus_ecosystem_clock WHERE id FOR UPDATE')).rows[0];
   if(!clock||new Date(clock.next_at).toISOString()!==period||new Date(clock.next_at).getTime()>Date.now())throw Error('ecosystem_recap_not_due');
   return (await q.query('INSERT INTO claus_ecosystem_recaps(period,input_hash,draft) VALUES($1,$2,$3::jsonb) RETURNING *',[period,inputHash,JSON.stringify(draft)])).rows[0];
  });
 }
 async complete(period:string,receipt:any){return this.db.transaction(async q=>{
  const old=(await q.query('SELECT * FROM claus_ecosystem_recaps WHERE period=$1 FOR UPDATE',[period])).rows[0];if(!old)throw Error('ecosystem_recap_missing');if(old.status==='completed')return old.receipt;
  await q.query("UPDATE claus_ecosystem_recaps SET status='completed',receipt=$2::jsonb,completed_at=now() WHERE period=$1",[period,JSON.stringify(receipt)]);
  // No catch-up bursts after an outage.
  await q.query("UPDATE claus_ecosystem_clock SET next_at=greatest(next_at+interval '7 days',now()+interval '7 days'),attention_at=NULL,attention_attempts=0 WHERE id AND next_at=$1::timestamptz",[period]);return receipt;
 });}
}
