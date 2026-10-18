import {Pool,neonConfig} from '@neondatabase/serverless';
import {createHash} from 'node:crypto';
const ident=v=>{if(typeof v!=='string'||!/^[_a-z][_a-z0-9]{0,62}$/.test(v))throw Error('website_identifier_invalid');return '"'+v+'"';};
const table=v=>'claus_website.'+ident(v);
const type=v=>{if(!['text','boolean','integer','bigint','numeric','uuid','jsonb','timestamptz','date','bytea','text[]'].includes(v))throw Error('website_column_type_invalid');return v;};
function column(c){return ident(c.name)+' '+type(c.type)+(c.required===true?' NOT NULL':'')+(c.primary===true?' PRIMARY KEY':'');}
export function migrationStatements(plan){
 if(plan.version!==1||plan.kind!=='database'||!Array.isArray(plan.steps)||!plan.steps.length||plan.steps.length>32)throw Error('website_migration_invalid');
 return plan.steps.map(s=>{
  switch(s.operation){
   case 'create_table':if(!Array.isArray(s.columns)||!s.columns.length||s.columns.length>64)throw Error('website_columns_invalid');return {sql:'CREATE TABLE '+table(s.table)+' ('+s.columns.map(column).join(',')+')'};
   case 'add_column':return {sql:'ALTER TABLE '+table(s.table)+' ADD COLUMN '+column(s.column)};
   case 'rename_table':return {sql:'ALTER TABLE '+table(s.table)+' RENAME TO '+ident(s.name)};
   case 'rename_column':return {sql:'ALTER TABLE '+table(s.table)+' RENAME COLUMN '+ident(s.column)+' TO '+ident(s.name)};
   case 'create_index':if(!Array.isArray(s.columns)||!s.columns.length)throw Error('website_columns_invalid');return {sql:'CREATE '+(s.unique===true?'UNIQUE ':'')+'INDEX '+ident(s.name)+' ON '+table(s.table)+' ('+s.columns.map(ident).join(',')+')'};
   case 'drop_index':return {sql:'DROP INDEX claus_website.'+ident(s.name)};
   case 'drop_table':return {sql:'DROP TABLE '+table(s.table)+' RESTRICT',backup:s.table};
   case 'drop_column':return {sql:'ALTER TABLE '+table(s.table)+' DROP COLUMN '+ident(s.column)+' RESTRICT',backup:s.table};
   case 'alter_type':return {sql:'ALTER TABLE '+table(s.table)+' ALTER COLUMN '+ident(s.column)+' TYPE '+type(s.type),backup:s.table};
   default:throw Error('website_migration_operation_invalid');
  }
 });
}
export function websiteDatabase(connection=()=>process.env.WEBSITE_DATABASE_URL){
 let pool;const database=()=>{if(!connection())throw Error('website_database_not_connected');if(typeof WebSocket!=='undefined')neonConfig.webSocketConstructor=WebSocket;if(!pool){pool=new Pool({connectionString:connection(),max:2,connectionTimeoutMillis:10000,idleTimeoutMillis:10000});pool.on('error',()=>{});}return pool;};
 return {
  async inspect(){const q=await database().connect();try{return {schema:'claus_website',columns:(await q.query("SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='claus_website' ORDER BY table_name,ordinal_position")).rows,migrations:(await q.query('SELECT id,source_hash,created_at FROM claus_website_admin.migrations ORDER BY created_at DESC LIMIT 20')).rows};}finally{q.release();}},
  async recover(id,sourceHash){const row=(await database().query('SELECT source_hash,result FROM claus_website_admin.migrations WHERE id=$1',[id])).rows[0];if(row&&row.source_hash!==sourceHash)throw Error('website_migration_identity_conflict');return row?.result??null;},
  async apply(id,sourceHash,plan){const statements=migrationStatements(plan),q=await database().connect();try{
   await q.query('BEGIN');await q.query("SET LOCAL statement_timeout='20s'");await q.query("SET LOCAL lock_timeout='3s'");await q.query('SELECT pg_advisory_xact_lock(6041818)');
   const old=(await q.query('SELECT source_hash,result FROM claus_website_admin.migrations WHERE id=$1',[id])).rows[0];if(old){if(old.source_hash!==sourceHash)throw Error('website_migration_identity_conflict');await q.query('COMMIT');return old.result;}
   const backups=[];for(let i=0;i<statements.length;i++){const s=statements[i];if(s.backup){const name='retained_'+createHash('sha256').update(id+':'+i).digest('hex').slice(0,28);await q.query('CREATE TABLE '+table(name)+' (LIKE '+table(s.backup)+' INCLUDING ALL)');await q.query('INSERT INTO '+table(name)+' SELECT * FROM '+table(s.backup));backups.push({original:s.backup,retained:name});}await q.query(s.sql);}
   const result={applied:true,id,sourceHash,schema:'claus_website',steps:statements.length,backups,at:new Date().toISOString(),codeRollbackRestoresData:false};
   await q.query('INSERT INTO claus_website_admin.migrations(id,source_hash,result) VALUES($1,$2,$3::jsonb)',[id,sourceHash,JSON.stringify(result)]);await q.query('COMMIT');return result;
  }catch(e){await q.query('ROLLBACK');throw e;}finally{q.release();}}
 };
}
