import {createHash} from 'node:crypto';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const ident=v=>{if(typeof v!=='string'||!/^[_a-z][_a-z0-9]{0,62}$/.test(v))throw Error('resource_database_identifier_invalid');return '"'+v+'"';};
export async function lockedSchemaSnapshot(db,id,schema,callback){
 await db.query('BEGIN');
 try{
  await db.query("SET LOCAL lock_timeout='3s'");await db.query("SET LOCAL statement_timeout='10s'");await db.query("SET LOCAL idle_in_transaction_session_timeout='150s'");
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[id]);
  const extras=(await db.query("SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('v','m','f'))+(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1)+(SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=$1 AND t.typtype IN ('d','e','r','m'))+(SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal) AS total",[schema])).rows[0];
  if(Number(extras?.total??0)>0)throw Error('resource_database_custom_schema_contract_required');
  const tables=(await db.query("SELECT c.relname AS name,c.relrowsecurity AS row_security,c.relforcerowsecurity AS force_row_security FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p') ORDER BY c.relname",[schema])).rows;
  if(tables.length>500)throw Error('resource_database_schema_too_large');
  if(tables.length)await db.query('LOCK TABLE '+tables.map(x=>ident(schema)+'.'+ident(x.name)).join(',')+' IN SHARE UPDATE EXCLUSIVE MODE');
  const columns=(await db.query("SELECT c.relname AS table_name,a.attname AS name,pg_catalog.format_type(a.atttypid,a.atttypmod) AS data_type,NOT a.attnotnull AS nullable,a.attidentity AS identity,a.attgenerated AS generated,pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_sql FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname=$1 AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum",[schema])).rows;
  const constraints=(await db.query("SELECT c.relname AS table_name,k.conname AS name,pg_get_constraintdef(k.oid,true) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 ORDER BY c.relname,k.conname",[schema])).rows;
  const indexes=(await db.query('SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=$1 ORDER BY tablename,indexname',[schema])).rows;
  const policies=(await db.query('SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname=$1 ORDER BY tablename,policyname',[schema])).rows;
  const result=tables.map(t=>({name:t.name,columns:columns.filter(c=>c.table_name===t.name).map(c=>({name:c.name,dataType:c.data_type,nullable:c.nullable,identity:c.identity,generated:c.generated,defaultHash:hash(c.default_sql)})),constraintsHash:hash(constraints.filter(c=>c.table_name===t.name)),indexesHash:hash(indexes.filter(i=>i.tablename===t.name)),policiesHash:hash({enabled:t.row_security===true,forced:t.force_row_security===true,policies:policies.filter(p=>p.tablename===t.name)})}));
  const migrations=tables.some(x=>x.name==='_claus_migrations')?(await db.query('SELECT id FROM '+ident(schema)+'._claus_migrations ORDER BY id')).rows.map(x=>x.id):[];
  const value={schema,tables:result,schemaHash:hash(result),migrations};const returned=await callback(value);await db.query('COMMIT');return returned;
 }catch(error){await db.query('ROLLBACK');if(/^resource_/.test(error.message??''))throw error;throw Error('resource_database_compatibility_unavailable');}
}
