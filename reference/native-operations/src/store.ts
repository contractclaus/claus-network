import {managedDatabase,managedSchemaReady} from './database-schema.js';
import {recoverOverdueGeneration} from './recovery.js';
import {initializeClubPrivacy} from './club-privacy.js';
import {textPrefix} from './text.ts';
import { neon } from '@neondatabase/serverless';
import { digest, validateConfiguration, type Configuration } from './config.js';

export function sql() {
  if (!process.env.DATABASE_URL) throw new Error('database_not_connected');
  return neon(process.env.DATABASE_URL);
}

export async function initialize() {if(managedDatabase())return managedSchemaReady();
  const db=sql();
  await db`CREATE TABLE IF NOT EXISTS claus_config (revision serial PRIMARY KEY, parent_revision integer UNIQUE NOT NULL, content jsonb NOT NULL, hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`;
  await db`CREATE TABLE IF NOT EXISTS claus_state (id integer PRIMARY KEY CHECK(id=1), generation integer NOT NULL DEFAULT 0, memory text NOT NULL DEFAULT '', agenda text NOT NULL DEFAULT '', next_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, lease_owner text, status text NOT NULL DEFAULT 'paused', updated_at timestamptz NOT NULL DEFAULT now())`;
  await db`INSERT INTO claus_state(id) VALUES(1) ON CONFLICT DO NOTHING`;
  await db`CREATE TABLE IF NOT EXISTS claus_actions (id text PRIMARY KEY, kind text NOT NULL, input_hash text NOT NULL, status text NOT NULL, result jsonb, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz)`;
  await db`ALTER TABLE claus_actions ADD COLUMN IF NOT EXISTS requested_model text`;
  await db`ALTER TABLE claus_actions ADD COLUMN IF NOT EXISTS input jsonb`;
  await db`ALTER TABLE claus_actions ADD COLUMN IF NOT EXISTS progress jsonb`;
  await db`CREATE TABLE IF NOT EXISTS claus_missions (id text PRIMARY KEY, body text NOT NULL, status text NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, result text)`;
  await db`ALTER TABLE claus_missions ADD COLUMN IF NOT EXISTS chain_write boolean NOT NULL DEFAULT false`;
  await db`CREATE TABLE IF NOT EXISTS claus_public (id text PRIMARY KEY, content jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`;
  await db`CREATE INDEX IF NOT EXISTS claus_public_originals ON claus_public(created_at,id) WHERE NOT (content ? 'revisionOf') AND content ? 'event'`;
  await db`CREATE INDEX IF NOT EXISTS claus_public_revisions ON claus_public((content->>'revisionOf'),created_at DESC,id DESC) WHERE content ? 'revisionOf'`;
  await db`CREATE TABLE IF NOT EXISTS claus_metadata (hash text PRIMARY KEY, content jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`;
  await db`ALTER TABLE claus_metadata ADD COLUMN IF NOT EXISTS encoded text`;
  await db`ALTER TABLE claus_state ADD COLUMN IF NOT EXISTS continuation jsonb`;
  await db`ALTER TABLE claus_state ADD COLUMN IF NOT EXISTS failure_count integer NOT NULL DEFAULT 0`;
  await db`CREATE INDEX IF NOT EXISTS claus_actions_unresolved ON claus_actions(created_at) WHERE status NOT IN ('completed','failed')`;
  await db`CREATE TABLE IF NOT EXISTS claus_x_inbox (post_id text PRIMARY KEY,author_id text NOT NULL,conversation_id text NOT NULL,post jsonb NOT NULL,status text NOT NULL DEFAULT 'pending',seen_at timestamptz,reply_id text,reason text,observed_at timestamptz NOT NULL DEFAULT now())`;
  await db`ALTER TABLE claus_x_inbox ADD COLUMN IF NOT EXISTS deferred_until timestamptz`;
  await db`ALTER TABLE claus_x_inbox ADD COLUMN IF NOT EXISTS operator_issue text`;
  await db`ALTER TABLE claus_x_inbox ADD COLUMN IF NOT EXISTS operator_reviewed_at timestamptz`;
  await db`CREATE INDEX IF NOT EXISTS claus_x_operator_review ON claus_x_inbox(observed_at,post_id) WHERE operator_issue IS NOT NULL AND operator_reviewed_at IS NULL`;
  await db`CREATE INDEX IF NOT EXISTS claus_x_pending ON claus_x_inbox(observed_at,post_id) WHERE status='pending'`;
  await db`CREATE TABLE IF NOT EXISTS claus_x_poll (id integer PRIMARY KEY CHECK(id=1),since_id text,page_token text,high_id text,started_at timestamptz NOT NULL DEFAULT now()-interval '24 hours',next_poll_at timestamptz NOT NULL DEFAULT now(),lease_owner text,lease_until timestamptz,last_error text)`;
  await db`INSERT INTO claus_x_poll(id) VALUES(1) ON CONFLICT DO NOTHING`;
  await db`CREATE TABLE IF NOT EXISTS claus_x_optouts (author_id text PRIMARY KEY,post_id text NOT NULL,enabled boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now())`;
  await db`CREATE TABLE IF NOT EXISTS claus_x_context (id text PRIMARY KEY,result jsonb,error text,checked_at timestamptz,next_at timestamptz NOT NULL,lease_owner text)`;
  await db`CREATE INDEX IF NOT EXISTS claus_x_author_history ON claus_x_inbox(author_id,(post_id::numeric) DESC)`;
  await db`CREATE INDEX IF NOT EXISTS claus_x_confirmed_replies ON claus_actions((input->>'replyTo')) WHERE kind='x_post' AND status='completed'`;
  await db`CREATE TABLE IF NOT EXISTS claus_club_wake (id boolean PRIMARY KEY CHECK(id),generation integer NOT NULL,ticket text NOT NULL,expires_at timestamptz NOT NULL)`;
  await db`CREATE TABLE IF NOT EXISTS claus_journal (id bigserial PRIMARY KEY, kind text NOT NULL, summary text NOT NULL, data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now())`;
  await db`CREATE INDEX IF NOT EXISTS claus_journal_search ON claus_journal USING gin(to_tsvector('simple',summary || ' ' || coalesce(data->>'memory','') || ' ' || coalesce(data->>'agenda','')))`;
  await db`CREATE TABLE IF NOT EXISTS claus_drafts (id text PRIMARY KEY, text text NOT NULL, reply_to text, status text NOT NULL DEFAULT 'draft', created_at timestamptz NOT NULL DEFAULT now())`;
  await db`ALTER TABLE claus_drafts ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'post'`;
  await db`ALTER TABLE claus_drafts ADD COLUMN IF NOT EXISTS content jsonb`;
  await db`CREATE TABLE IF NOT EXISTS claus_memories (id text PRIMARY KEY, input_hash text NOT NULL, title text NOT NULL, body text NOT NULL, sources jsonb NOT NULL DEFAULT '[]', supersedes text UNIQUE REFERENCES claus_memories(id), created_at timestamptz NOT NULL DEFAULT now())`;
  await db`CREATE INDEX IF NOT EXISTS claus_memories_search ON claus_memories USING gin(to_tsvector('simple', title || ' ' || body))`;
  await db`CREATE TABLE IF NOT EXISTS claus_projects (id text PRIMARY KEY, title text NOT NULL, summary text NOT NULL, sandbox_name text UNIQUE NOT NULL, snapshot_id text, version integer NOT NULL DEFAULT 1, last_exit_code integer, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`;
  await initializeClubPrivacy();
}
// Configuration writes belong to the separately authenticated fixed custodian.
export async function configure(_content: Configuration, _expectedRevision=0):Promise<never> {throw Error('configuration_managed_externally');}
export async function historicalConfiguration(revision:number) {return (await sql()`SELECT revision,content,hash FROM claus_config WHERE revision=${revision}`)[0]??null;}
export async function configuration() {
  const rows=await sql()`SELECT revision,content,hash FROM claus_config ORDER BY revision DESC LIMIT 1`;
  if (!rows.length) throw new Error('configuration_not_seeded');
  validateConfiguration(rows[0].content);
  return {revision:rows[0].revision as number,hash:rows[0].hash as string,...rows[0].content as Configuration};
}
export async function state() { return (await sql()`SELECT * FROM claus_state WHERE id=1`)[0]; }
export async function pauseIdle(generation:number) {
  await sql()`UPDATE claus_state SET status='paused',updated_at=now() WHERE id=1 AND generation=${generation} AND (lease_until IS NULL OR lease_until<now())`;
}
export async function newGeneration() { return (await sql()`UPDATE claus_state SET generation=generation+1,next_at=now(),updated_at=now() WHERE id=1 RETURNING generation`)[0].generation as number; }
export async function beginGeneration(expected:number) {
  const rows=await sql()`UPDATE claus_state SET generation=generation+1,status='starting',next_at=now(),updated_at=now() WHERE id=1 AND generation=${expected} AND status='paused' AND (lease_until IS NULL OR lease_until<now())
    AND NOT EXISTS (SELECT 1 FROM claus_actions a WHERE a.status NOT IN ('completed','failed') AND NOT (
      (SELECT content->'settings'->>'role' FROM claus_config ORDER BY revision DESC LIMIT 1)='twitter'
      AND a.kind='x_post' AND a.status='uncertain' AND a.id~'^x_reply_[1-9][0-9]{0,18}:[0-9]+$'
      AND split_part(a.id,':',1)='x_reply_'||(a.input->>'replyTo')
      AND EXISTS(SELECT 1 FROM claus_x_inbox i WHERE i.post_id=a.input->>'replyTo' AND i.author_id=a.input->>'replyAuthorId'
        AND i.status='delivery_blocked' AND i.reason='reply_outcome_uncertain')
    )) RETURNING generation`;
  return rows[0]?.generation as number|undefined;
}
export async function recoverGeneration(expected:number,mentions=false) {
 return recoverOverdueGeneration({query:async<T=any>(statement:string,params?:any[])=>({rows:await sql().query(statement,params) as T[]})},expected,mentions);
}

export async function acquire(id: string, generation:number,waitingOnly=false) {
  const rows=await sql()`UPDATE claus_state SET lease_until=now()+interval '15 minutes',lease_owner=${id},status='working',updated_at=now() WHERE id=1 AND generation=${generation} AND status NOT IN ('paused','blocked') AND (lease_until IS NULL OR lease_until<now()) AND (NOT ${waitingOnly} OR status='waiting') RETURNING *`;
  return rows[0] ?? null;
}
export async function release(id:string, memory:string, agenda:string, nextAt:string, status:string,continuation:unknown=null,failureCount=0) {
  await sql()`UPDATE claus_state SET memory=${memory},agenda=${agenda},continuation=${JSON.stringify(continuation)}::jsonb,next_at=${nextAt}::timestamptz,status=${status},failure_count=${failureCount},lease_until=NULL,lease_owner=NULL,updated_at=now() WHERE id=1 AND lease_owner=${id}`;
}
export async function journal(kind:string,summary:string,data:unknown={}) {
  const explicit=(data as any)?.visibility;
  const visibility=['private_club','private_network'].includes(explicit)?explicit:['thought','checkpoint'].includes(kind)?'private_network':'public';
  return (await sql()`INSERT INTO claus_journal(kind,summary,data,visibility) VALUES(${kind},${textPrefix(summary,4000)},${JSON.stringify(data)}::jsonb,${visibility}) RETURNING id`)[0].id;
}
export async function recent(limit=20) { return sql()`SELECT id,kind,summary,data,created_at FROM claus_journal ORDER BY id DESC LIMIT ${limit}`; }
export async function recentSummaries(limit=8) {return sql()`SELECT 'j_'||id::text AS id,kind,summary,created_at FROM claus_journal WHERE visibility='public' ORDER BY id DESC LIMIT ${limit}`;}
export async function saveDraft(id:string,text:string,replyTo?:string) {
  await sql()`INSERT INTO claus_drafts(id,text,reply_to) VALUES(${id},${text},${replyTo??null}) ON CONFLICT(id) DO NOTHING`;
  return {id,status:'draft',text,replyTo:replyTo??null};
}
export async function drafts() { return sql()`SELECT * FROM claus_drafts ORDER BY created_at DESC LIMIT 30`; }
export async function unresolved() {return sql()`SELECT id,kind,status,created_at,requested_model,input,progress FROM claus_actions WHERE status NOT IN ('completed','failed') ORDER BY created_at`;}
export async function actionProgress(id:string,progress:unknown) {
  await sql()`UPDATE claus_actions SET progress=${JSON.stringify(progress)}::jsonb WHERE id=${id} AND status NOT IN ('completed','failed')`;
}
type ActionQuery=(strings:TemplateStringsArray,...values:any[])=>Promise<any[]>;
export async function settleAction(id:string,result:unknown,status='completed',db:ActionQuery=sql()) {
  await db`UPDATE claus_actions SET status=${status},result=${JSON.stringify(result)}::jsonb,completed_at=now() WHERE id=${id} AND status NOT IN ('completed','failed')`;
}
export function canReconcileActions(actions:any[]) {
  const kinds=['club','inference','image','wallet_prepare','wallet_execute','wallet_sign','wallet_replace','release','x_post','public_update','public_journal','etherscan_source','source_verification','programmable_api'];
  return actions.length>0&&actions.every(action=>kinds.includes(action.kind)||action.kind==='sandbox'&&!!action.progress?.commandId);
}
export class ConfirmedFailure extends Error {
  constructor(message:string,readonly retryAt?:string) {super(message);}
}
export function failureReceipt(error:ConfirmedFailure) {
  return {error:error.message,...(error.retryAt&&Number.isFinite(Date.parse(error.retryAt))?{retryAt:new Date(error.retryAt).toISOString()}:{})};
}
export async function reconcileWallet(id:string,status:'completed'|'failed',result:unknown) {
  const rows=await sql()`UPDATE claus_actions SET status=${status},result=${JSON.stringify(result)}::jsonb,completed_at=now() WHERE id=${id} AND kind IN ('wallet_prepare','wallet_execute','wallet_sign','wallet_replace','release') AND status NOT IN ('completed','failed') RETURNING id`;
  if(rows.length)await journal('wallet_reconciled',`Wallet action ${status}`,{action:id,status,result});
}
export async function reconcileInference(id:string,status:'completed'|'failed',result:unknown) {
  const rows=await sql()`UPDATE claus_actions SET status=${status},result=${JSON.stringify(result)}::jsonb,completed_at=now() WHERE id=${id} AND kind='inference' AND status NOT IN ('completed','failed') RETURNING id`;
  if(rows.length)await journal('inference_reconciled',`Inference request ${status}`,{action:id,status,result});
}

// A committed reservation precedes each effect. Uncertain results never resend
// automatically, including after workflow replay or a process crash.
export async function once<T>(id:string,kind:string,input:unknown,fn:()=>Promise<T>,db:ActionQuery=sql(),admit?:()=>Promise<any[]>):Promise<T> {
  const hash=digest(input);
  const model=kind==='inference'?(input as any)?.model??null:null;
  const inserted=admit?await admit():await db`INSERT INTO claus_actions(id,kind,input_hash,status,requested_model,input,visibility) VALUES(${id},${kind},${hash},'pending',${model},${kind==='inference'?null:JSON.stringify(input)}::jsonb,${id.startsWith('club:')?'private_club':['network_program','network_program_run','programmable_api','external_tools','external_adapter'].includes(kind)?'private_network':'public'}) ON CONFLICT DO NOTHING RETURNING id`;
  if (!inserted.length) {
    const row=(await db`SELECT * FROM claus_actions WHERE id=${id}`)[0];
    if (row.input_hash!==hash) throw new Error('action_id_conflict');
    if (row.status==='failed') throw new Error(`action_confirmed_failed:${id}`);
    if (row.status!=='completed') throw new Error(`action_requires_reconciliation:${id}`);
    return row.result as T;
  }
  try {
    const result=await fn();
    const saved=await db`UPDATE claus_actions SET status='completed',result=${JSON.stringify(result)}::jsonb,completed_at=now() WHERE id=${id} AND status NOT IN ('completed','failed') RETURNING result`;
    if(saved.length)return saved[0].result as T;
    const original=(await db`SELECT status,result FROM claus_actions WHERE id=${id}`)[0];
    if(original?.status==='completed')return original.result as T;
    throw new Error(`action_confirmed_failed:${id}`);
  } catch(error) {
    if(error instanceof ConfirmedFailure) {
      await settleAction(id,failureReceipt(error),'failed',db);
      const original=(await db`SELECT status,result FROM claus_actions WHERE id=${id}`)[0];
      if(original?.status==='completed')return original.result as T;
      throw error;
    }
    await db`UPDATE claus_actions SET status='uncertain' WHERE id=${id} AND status NOT IN ('completed','failed')`;
    const original=(await db`SELECT status,result FROM claus_actions WHERE id=${id}`)[0];
    if(original?.status==='completed')return original.result as T;
    if(original?.status==='failed')throw new Error(`action_confirmed_failed:${id}`);
    throw new Error(`action_requires_reconciliation:${id}`);
  }
}
