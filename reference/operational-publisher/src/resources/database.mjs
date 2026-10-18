import {Pool,neonConfig} from '@neondatabase/serverless';
import {createHash} from 'node:crypto';
import {applicationMigrationStatements,applicationDatabaseFeatures} from './application-migrations.mjs';
const ident=v=>{if(typeof v!=='string'||!/^[_a-z][_a-z0-9]{0,62}$/.test(v))throw Error('resource_database_identifier_invalid');return '"'+v+'"';};
export function resourceDatabase({env=process.env,poolFactory=options=>new Pool(options)}={}){
 async function withDb(connection,callback){if(!connection)throw Error('resource_database_not_connected');if(typeof WebSocket!=='undefined')neonConfig.webSocketConstructor=WebSocket;const pool=poolFactory({connectionString:connection,max:1,connectionTimeoutMillis:10000});pool.on?.('error',()=>{});try{return await callback(pool);}finally{await pool.end();}}
 function binding(id,connection){const url=new URL(connection),suffix=id.slice(4);if(!/^res_[a-f0-9]{24}$/.test(id)||url.pathname!=='/claus_applications'||decodeURIComponent(url.username)!=='claus_app_'+suffix)throw Error('resource_database_binding_invalid');return {schema:'app_'+suffix,role:'claus_app_'+suffix};}
 return {
  connection(id,password){if(!env.RESOURCE_DATABASE_URL)throw Error('resource_database_not_connected');const url=new URL(env.RESOURCE_DATABASE_URL);url.username='claus_app_'+id.slice(4);url.password=password;binding(id,url.href);return url.href;},
  async provision(id,connection){const expected=binding(id,connection),password=decodeURIComponent(new URL(connection).password);return withDb(env.RESOURCE_DATABASE_URL,async db=>{const v=(await db.query('SELECT claus_resource_admin.provision($1,$2) AS value',[id,password])).rows[0].value;if(v.schema!==expected.schema||v.role!==expected.role||v.database!=='claus_applications')throw Error('resource_database_binding_invalid');return v;});},
  async credential(id,connection,expectedRevision,revoked,actionId){binding(id,connection);return withDb(env.RESOURCE_DATABASE_URL,async db=>(await db.query('SELECT claus_resource_admin.change_credential($1,$2,$3,$4,$5) AS value',[id,expectedRevision,decodeURIComponent(new URL(connection).password),revoked,actionId])).rows[0].value);},
  async inspect(id,connection){const {schema,role}=binding(id,connection);return withDb(connection,async db=>({database:'claus_applications',schema,role,features:applicationDatabaseFeatures,columns:(await db.query('SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema=$1 ORDER BY table_name,ordinal_position',[schema])).rows,indexes:(await db.query('SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=$1 ORDER BY tablename,indexname',[schema])).rows,migrations:(await db.query('SELECT id,source_hash,created_at FROM '+ident(schema)+'._claus_migrations ORDER BY created_at DESC LIMIT 30')).rows,extensions:(await db.query("SELECT extname,extversion FROM pg_extension WHERE extname IN ('vector','pg_trgm')")).rows}));},
  async migrate(id,connection,actionId,sourceHash,plan){
   const {schema}=binding(id,connection),table=name=>ident(schema)+'.'+ident(name);
   const statements=applicationMigrationStatements(plan).map(s=>({...s,sql:s.sql.replaceAll('claus_website.',ident(schema)+'.')}));
   return withDb(connection,async pool=>{const db=await pool.connect();try{
    await db.query('BEGIN');await db.query("SET LOCAL statement_timeout='25s'");await db.query("SET LOCAL lock_timeout='3s'");await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[id]);
    const prior=(await db.query('SELECT source_hash,result FROM '+table('_claus_migrations')+' WHERE id=$1',[actionId])).rows[0];
    if(prior){if(prior.source_hash!==sourceHash)throw Error('resource_database_migration_conflict');await db.query('COMMIT');return prior.result;}
    const backups=[];
    for(let i=0;i<statements.length;i++){const s=statements[i];if(s.backup){const name='retained_'+createHash('sha256').update(actionId+':'+i).digest('hex').slice(0,28);await db.query('CREATE TABLE '+table(name)+' (LIKE '+table(s.backup)+' INCLUDING ALL)');await db.query('INSERT INTO '+table(name)+' SELECT * FROM '+table(s.backup));backups.push({original:s.backup,retained:name});}await db.query(s.sql);}
    const result={applied:true,resourceId:id,database:'claus_applications',schema,steps:statements.length,backups,sourceHash,at:new Date().toISOString(),codeRollbackRestoresData:false};
    await db.query('INSERT INTO '+table('_claus_migrations')+'(id,source_hash,result) VALUES($1,$2,$3::jsonb)',[actionId,sourceHash,JSON.stringify(result)]);await db.query('COMMIT');return result;
   }catch(e){await db.query('ROLLBACK');if(/^resource_/.test(e.message))throw e;throw Error('resource_database_migration_failed');}finally{db.release();}});
  }
 };
}
