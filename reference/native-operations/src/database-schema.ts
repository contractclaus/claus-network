import {neon} from '@neondatabase/serverless';
import schema from './database-schema.json' with {type:'json'};
export const managedDatabase=()=>process.env.NATIVE_DATABASE_MANAGED==='true';
export const schemaQuery="SELECT c.relname AS table_name,a.attname AS column_name,format_type(a.atttypid,a.atttypmod) AS data_type,a.attnotnull AS required,a.attidentity AS identity,a.attgenerated AS generated FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum";
let pending:Promise<void>|undefined;
export function verifyNativeSchema(expected:any[],actual:any[]){
 const byColumn=new Map(actual.map(row=>[row.table_name+'\0'+row.column_name,row]));
 for(const column of expected){const row=byColumn.get(column.table_name+'\0'+column.column_name);if(!row||Object.keys(column).some(key=>row[key]!==column[key]))throw Error('native_database_schema_mismatch');}
}
export function managedSchemaReady():Promise<void>{
 if(!managedDatabase())return Promise.resolve();
 return pending??=(async()=>{
  const db=neon(process.env.DATABASE_URL!);
  const [identity]=await db`SELECT current_user AS role,has_schema_privilege(current_user,'public','CREATE') AS schema_create,has_table_privilege(current_user,'claus_config','INSERT,UPDATE,DELETE,TRUNCATE') AS configuration_write,pg_has_role(current_user,'claus_agent','MEMBER') AS owner_member`;
  if(identity?.role!=='claus_native_runtime'||identity.schema_create||identity.configuration_write||identity.owner_member)throw Error('native_database_role_mismatch');
  verifyNativeSchema(schema.columns,await db.query(schemaQuery));
 })().catch(error=>{pending=undefined;throw error;});
}
