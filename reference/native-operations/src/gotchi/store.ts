import {managedDatabase,managedSchemaReady} from '../database-schema.js';
import type {LabDatabase} from '../lab-db.js';
import {advance,parseCommand,sourceHash,view,type Pet,type Receipt} from './engine.js';

export type Source={id:string;authorId:string;text:string;createdAt:string;canStart:boolean};
export class GotchiStore {
  constructor(readonly db:LabDatabase){}
  async initialize(){if(managedDatabase())return managedSchemaReady();await this.db.query(`
    CREATE TABLE IF NOT EXISTS claus_gotchi_players(owner_id text PRIMARY KEY,state jsonb,updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
    CREATE TABLE IF NOT EXISTS claus_gotchi_events(post_id text PRIMARY KEY,owner_id text NOT NULL REFERENCES claus_gotchi_players(owner_id),source_hash text NOT NULL,receipt jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
    CREATE INDEX IF NOT EXISTS claus_gotchi_events_owner ON claus_gotchi_events(owner_id,created_at);
  `);}
  async read(ownerId:string){
    if(!/^[1-9][0-9]{0,18}$/.test(ownerId))throw Error('gotchi_invalid_source');
    const row=(await this.db.query<{state:Pet|null;at:string}>('SELECT state,clock_timestamp() AS at FROM claus_gotchi_players WHERE owner_id=$1',[ownerId])).rows[0];
    return row?.state?view(row.state,new Date(row.at).getTime()):null;
  }
  async act(source:Source):Promise<Receipt&{replayed:boolean}> {
    if(!/^[1-9][0-9]{0,18}$/.test(source.id)||!/^[1-9][0-9]{0,18}$/.test(source.authorId))throw Error('gotchi_invalid_source');
    const command=parseCommand(source.text);if(!command)throw Error('gotchi_exact_command_required');
    const hash=sourceHash({id:source.id,authorId:source.authorId,text:source.text,createdAt:source.createdAt});
    return this.db.transaction(async q=>{
      await q.query("SET LOCAL lock_timeout='2s'");
      // Per-account serialization covers concurrent adoption, care and replay.
      await q.query('INSERT INTO claus_gotchi_players(owner_id) VALUES($1) ON CONFLICT DO NOTHING',[source.authorId]);
      const row=(await q.query<{state:Pet|null}>('SELECT state FROM claus_gotchi_players WHERE owner_id=$1 FOR UPDATE',[source.authorId])).rows[0];
      const old=(await q.query('SELECT owner_id,source_hash,receipt FROM claus_gotchi_events WHERE post_id=$1',[source.id])).rows[0];
      if(old){if(old.owner_id!==source.authorId||old.source_hash!==hash)throw Error('gotchi_source_conflict');return {...old.receipt,replayed:true};}
      if(!source.canStart)throw Error('gotchi_source_expired');
      // The consent writer uses normal INSERT/UPDATE locks. Keep its state
      // stable until commit, including the case where no opt-out row exists.
      await q.query('LOCK TABLE claus_x_optouts IN SHARE MODE');
      const optedOut=(await q.query('SELECT EXISTS(SELECT 1 FROM claus_x_optouts WHERE author_id=$1 AND enabled) AS excluded',[source.authorId])).rows[0].excluded;
      if(optedOut)throw Error('gotchi_source_unavailable');
      const inbox=(await q.query('SELECT status,author_id,post FROM claus_x_inbox WHERE post_id=$1 FOR UPDATE',[source.id])).rows[0];
      if(!inbox||!['pending','retrying'].includes(inbox.status)||inbox.author_id!==source.authorId||inbox.post?.text!==source.text||inbox.post?.created_at!==source.createdAt)throw Error('gotchi_source_changed');
      const at=new Date((await q.query('SELECT clock_timestamp() AS at')).rows[0].at).getTime();
      const {state,receipt}=advance(row.state,source.authorId,command,at,Date.parse(source.createdAt),source.id);
      const recent=(await q.query('SELECT count(*)::int AS n FROM claus_gotchi_events WHERE owner_id=$1 AND created_at>clock_timestamp()-interval \'1 hour\'',[source.authorId])).rows[0];
      const emergencyPause=command.action==='pause'&&row.state?.paused===false&&receipt.outcome==='paused';
      if(recent.n>=12&&!emergencyPause)throw Error('gotchi_try_later');
      await q.query('UPDATE claus_gotchi_players SET state=$2::jsonb,updated_at=clock_timestamp() WHERE owner_id=$1',[source.authorId,JSON.stringify(state)]);
      await q.query('INSERT INTO claus_gotchi_events(post_id,owner_id,source_hash,receipt) VALUES($1,$2,$3,$4::jsonb)',[source.id,source.authorId,hash,JSON.stringify(receipt)]);
      return {...receipt,replayed:false};
    });
  }
}
