import {Pool,neonConfig} from '@neondatabase/serverless';
import {hash} from './policy.js';
const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const equal=(a,b)=>canonical(a)===canonical(b);
const authority=c=>c?.scope?{scope:c.scope,enabled:c.enabled,revision:c.revision,deployment:c.deployment,manifest:c.manifest,crons:c.crons}:{id:c?.id,enabled:c?.enabled,revision:c?.revision,project_id:c?.project_id,active_id:c?.active_id,fallback_id:c?.fallback_id};
const fail=()=>{throw Error('publisher_control_conflict');};
let singleton;
export function publicationDatabase(){
 if(singleton)return singleton;if(!process.env.PUBLISHER_CONTROL_DATABASE_URL)throw Error('publisher_controls_unavailable');
 if(typeof WebSocket!=='undefined')neonConfig.webSocketConstructor=WebSocket;
 const pool=new Pool({connectionString:process.env.PUBLISHER_CONTROL_DATABASE_URL,max:2,connectionTimeoutMillis:10000,idleTimeoutMillis:10000});pool.on('error',()=>{});
 return singleton={query:(q,p)=>pool.query(q,p),transaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='12000ms'");const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
}
export function publicationControls(db=publicationDatabase()){
 async function change(key,kind,c,r,fn){return db.transaction(async q=>{
  await q.query('SELECT pg_advisory_xact_lock(6041010)');if(kind==='surface')await q.query('SELECT pg_advisory_xact_lock(6041414)');
  const old=(await q.query('SELECT * FROM claus_publication_audit WHERE id=$1',[key])).rows[0];
  const fresh=(await q.query(kind==='surface'?'SELECT * FROM claus_surface_control WHERE id':'SELECT * FROM claus_operations_control WHERE scope=$1',kind==='surface'?[]:[c.scope])).rows[0];
  const signature=hash({control:authority(c),release:r});
  if(old){if(old.input_hash!==signature||!equal(authority(fresh),authority(old.after_state)))fail();return old.after_state;}
  if(!equal(authority(c),authority(fresh)))fail();
  const rows=await q.query(kind==='surface'?'SELECT * FROM claus_surface_releases WHERE id=$1 FOR UPDATE':'SELECT * FROM claus_operations_releases WHERE id=$1 FOR UPDATE',[r.id]);
  if(!equal(r,rows.rows[0]))fail();
  const settings=(await q.query('SELECT content FROM claus_config ORDER BY revision DESC LIMIT 1')).rows[0]?.content;
  if(!fresh.enabled||!settings?.settings.enabled||!settings.settings.builder?.enabled||!settings.settings.networkOperations?.enabled||!settings.policy?.capabilities.networkBuild)throw Error('publisher_disabled');
  const after=await fn(q,fresh);
  await q.query('INSERT INTO claus_publication_audit(id,kind,input_hash,before_state,after_state) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)',[key,kind,signature,JSON.stringify(c),JSON.stringify(after)]);return after;
 });}
 return {
  async activated(kind,id,action='activate'){return (await db.query('SELECT after_state FROM claus_publication_audit WHERE id=$1',[kind+':'+id+':'+action])).rows[0]?.after_state??null;},
  async activateOperation(c,r,proof){return change('operation:'+r.id+':activate','operation',c,r,async q=>{
   if(c.revision!==r.base_revision||c.deployment!==r.base_deployment||r.state!=='verified')fail();
   const next=(await q.query('UPDATE claus_operations_control SET revision=revision+1,deployment=$2,manifest=$3::jsonb,updated_at=now() WHERE scope=$1 AND revision=$4 RETURNING *',[r.scope,r.deployment.id,JSON.stringify(r.manifest),c.revision])).rows[0];if(!next)fail();
   await q.query("UPDATE claus_operations_releases SET state='active',proof=$2::jsonb,updated_at=now() WHERE id=$1",[r.id,JSON.stringify(proof)]);return next;
  });},
  async rollbackOperation(c,r,manifest,proof){return change('operation:'+r.id+':rollback','operation',c,r,async q=>{
   if(!['rollback_pending','rolling_back'].includes(r.state)||!(c.deployment===r.deployment?.id&&c.revision===r.base_revision+1||c.deployment===r.base_deployment&&c.revision===r.base_revision))fail();
   const next=c.deployment===r.base_deployment?c:(await q.query('UPDATE claus_operations_control SET revision=revision+1,deployment=$2,manifest=$3::jsonb,updated_at=now() WHERE scope=$1 AND revision=$4 RETURNING *',[r.scope,r.base_deployment,JSON.stringify(manifest),c.revision])).rows[0];if(!next)fail();
   await q.query("UPDATE claus_operations_releases SET state='rolled_back',proof=$2::jsonb,updated_at=now() WHERE id=$1",[r.id,JSON.stringify(proof)]);return next;
  });},
  async activateSurface(c,r,proof){return change('surface:'+r.id+':activate','surface',c,r,async q=>{
   if(c.revision!==r.base_revision||r.state!=='verified')fail();
   const next=(await q.query('UPDATE claus_surface_control SET active_id=$1,fallback_id=active_id,revision=revision+1,failures=0,last_checked=now() WHERE id AND revision=$2 RETURNING *',[r.id,c.revision])).rows[0];if(!next)fail();
   await q.query("UPDATE claus_surface_releases SET state='active',proof=$2::jsonb,updated_at=now() WHERE id=$1",[r.id,JSON.stringify(proof)]);return next;
  });},
  async monitorSurface(c,healthy){return db.transaction(async q=>{await q.query('SELECT pg_advisory_xact_lock(6041414)');return (await q.query("UPDATE claus_surface_control SET last_checked=now(),failures=CASE WHEN $1 THEN 0 ELSE failures+1 END WHERE id AND enabled AND revision=$2 AND active_id=$3 AND (last_checked IS NULL OR last_checked<now()-interval '60 seconds') RETURNING *",[healthy,c.revision,c.active_id])).rows[0]??null;});},
  async rollbackSurface(c,r,proof){return change('surface:'+r.id+':rollback:'+c.revision,'surface',c,r,async(q,fresh)=>{
   if(fresh.failures<2||!fresh.fallback_id||fresh.active_id!==r.id)fail();
   const next=(await q.query('UPDATE claus_surface_control SET active_id=fallback_id,fallback_id=NULL,revision=revision+1,failures=0 WHERE id AND revision=$1 RETURNING *',[c.revision])).rows[0];if(!next)fail();
   await q.query("UPDATE claus_surface_releases SET state='rolled_back',proof=COALESCE(proof,'{}'::jsonb)||$2::jsonb,updated_at=now() WHERE id=$1",[r.id,JSON.stringify({rollback:proof})]);return next;
  });},
  async adoptNative(deployment){return db.transaction(async q=>{
   await q.query('SELECT pg_advisory_xact_lock(6041010)');
   const c=(await q.query("SELECT * FROM claus_operations_control WHERE scope='native'")).rows[0];
   const pin=(await q.query('SELECT * FROM claus_builder_deployment WHERE id FOR UPDATE')).rows[0];
   if(!c?.enabled||c.deployment!==deployment||!pin)return null;if(pin.deployment_id===deployment)return pin;
   const accepted=(await q.query("SELECT after_state FROM claus_publication_audit WHERE kind='operation' AND after_state->>'deployment'=$1 ORDER BY created_at DESC LIMIT 1",[deployment])).rows[0];
   if(!accepted||!equal(authority(accepted.after_state),authority(c)))fail();
   if((await q.query('SELECT id FROM claus_builds WHERE lease_until>now() LIMIT 1')).rows.length)return null;
   const next=(await q.query('UPDATE claus_builder_deployment SET revision=revision+1,deployment_id=$1,updated_at=now() WHERE id RETURNING *',[deployment])).rows[0];
   await q.query('INSERT INTO claus_publication_audit(id,kind,input_hash,before_state,after_state) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)',['pin:'+deployment+':'+next.revision,'pin',hash({pin,deployment}),JSON.stringify(pin),JSON.stringify(next)]);return next;
  });}
 };
}
