import {managedDatabase,managedSchemaReady} from './database-schema.js';
import {feedbackBuildTools} from './feedback-builds.js';
import {adaptationTools} from './adaptation-service.js';
import {continuityTools} from './workspaces/continuity-service.js';
import {contributionTools} from './workspaces/review-service.js';
import {siteTools,publicSiteTools} from './site/service.js';
import {sql} from './store.js';
import {clubTools} from './club.js';
import {builderTools} from './builder-schema.js';

export const clubReaders=new Set(['generate_image','review_image','read_network','read_publication','read_knowledge','read_reference','read_url','read_image','read_work','read_developments','read_x_account','read_x_thread','recall_conversation','read_chain','read_contract_source','read_market','remember','recall','finish']);
export function channelAllows(name:string,channel:'public'|'club'='public'){
 return channel==='club' ? feedbackBuildTools.has(name)||adaptationTools.has(name)||continuityTools.has(name)||contributionTools.has(name)||clubTools.has(name)||clubReaders.has(name)||builderTools.has(name)||siteTools.has(name) : !continuityTools.has(name)&&!contributionTools.has(name)&&!clubTools.has(name)&&!builderTools.has(name)&&(!siteTools.has(name)||publicSiteTools.has(name));
}
export async function initializeClubPrivacy(){if(managedDatabase())return managedSchemaReady();
 const db=sql();
 await db`CREATE TABLE IF NOT EXISTS claus_club_private(id boolean PRIMARY KEY DEFAULT true CHECK(id),memory text NOT NULL DEFAULT '',agenda text NOT NULL DEFAULT '',checkpoint jsonb,legacy jsonb,isolated_at timestamptz)`;
 for(const table of ['claus_journal','claus_memories','claus_projects','claus_drafts','claus_actions'])await db.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'public'`);
 await db`ALTER TABLE claus_club_private ADD COLUMN IF NOT EXISTS last_channel text`;
 await db`CREATE TABLE IF NOT EXISTS claus_club_bridge(id boolean PRIMARY KEY DEFAULT true CHECK(id),result jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now())`;
 await db`CREATE UNIQUE INDEX IF NOT EXISTS claus_memories_supersession_scope ON claus_memories(supersedes,visibility)`;
 await db`ALTER TABLE claus_memories DROP CONSTRAINT IF EXISTS claus_memories_supersedes_key`;
 await db`INSERT INTO claus_club_private(id) VALUES(true) ON CONFLICT DO NOTHING`;
}
// Run only while holding the existing global turn lease, after effect reconciliation.
// Earlier mixed notes remain available privately; public X history stays in its own readers.
export async function establishClubBoundary(owner:string,state:any){
 const db=sql(),[privateState]=await db`SELECT isolated_at FROM claus_club_private WHERE id`;
 if(privateState?.isolated_at)return state;
 const [start]=await db`SELECT min(created_at) AS at FROM claus_actions WHERE kind='club'`;
 const at=start?.at??new Date().toISOString();
 const [old]=await db`SELECT data->>'memory' AS memory,data->>'agenda' AS agenda FROM claus_journal WHERE created_at<${at} AND kind='checkpoint' AND data ? 'memory' ORDER BY id DESC LIMIT 1`;
 const memory=old?.memory??'',agenda=old?.agenda??'Continue public conversations and the current owner-approved schedule. Read actual Lab records for research progress.';
 await db.transaction([
  db`UPDATE claus_club_private SET memory=${state.memory??''},agenda=${state.agenda??''},legacy=${JSON.stringify({memory:state.memory,agenda:state.agenda,continuation:state.continuation})}::jsonb,isolated_at=now() WHERE id AND isolated_at IS NULL`,
  ...['claus_journal','claus_memories','claus_drafts','claus_actions'].map(table=>db.query(`UPDATE ${table} SET visibility='private_club' WHERE created_at >= $1`,[at])),
  db`UPDATE claus_projects SET visibility='private_club' WHERE updated_at>=${at}`,
  db`UPDATE claus_state SET memory=${memory},agenda=${agenda},continuation=NULL WHERE id=1 AND lease_owner=${owner}`
 ]);
 return {...state,memory,agenda,continuation:null};
}
