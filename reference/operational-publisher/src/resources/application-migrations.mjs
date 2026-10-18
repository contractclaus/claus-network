import {createHash} from 'node:crypto';
import {migrationStatements} from '../website-admin/database.mjs';
const fail=c=>{throw Error('resource_database_'+c);};
const ident=v=>{if(typeof v!=='string'||!/^[_a-z][_a-z0-9]{0,62}$/.test(v))fail('identifier_invalid');return '"'+v+'"';};
const table=v=>'claus_website.'+ident(v); // Bound to the owned schema by resourceDatabase.
function type(v){
 if(['text','boolean','integer','bigint','numeric','uuid','jsonb','timestamptz','date','bytea','text[]','tsvector'].includes(v))return v;
 const m=typeof v==='string'&&/^(vector|halfvec)\(([1-9][0-9]{0,4})\)$/.exec(v);
 if(m&&Number(m[2])<=16000)return 'extensions.'+m[1]+'('+m[2]+')';
 fail('column_type_invalid');
}
const column=c=>{if(!c||typeof c!=='object')fail('column_invalid');return ident(c.name)+' '+type(c.type)+(c.required===true?' NOT NULL':'')+(c.primary===true?' PRIMARY KEY':'');};
const columns=v=>{if(!Array.isArray(v)||!v.length||v.length>64||new Set(v).size!==v.length)fail('columns_invalid');return v.map(ident);};
export const applicationDatabaseFeatures={
 storage:'Existing isolated application database, without adding a provider',
 scalarTypes:['text','boolean','integer','bigint','numeric','uuid','jsonb','timestamptz','date','bytea','text[]','tsvector'],
 vector:{types:['vector(dimensions)','halfvec(dimensions)'],maximumDimensions:16000,index:'hnsw',maximumIndexedDimensions:{vector:2000,halfvec:4000},indexVectorType:'vector by default; select vectorType:halfvec for a half-precision column',metrics:['cosine','l2','inner_product'],namespace:'extensions'},
 search:{fullText:'Stored generated tsvector with optional GIN index',languages:['simple','english','german'],trigram:'GIN index with extensions.gin_trgm_ops'},
 cache:{operation:'create_cache_table',columns:['key text primary key','value jsonb','expires_at timestamptz','created_at timestamptz'],expiry:'Application reads must require expires_at > now(); cleanup runs through an explicit owned job. No background TTL deletion is implied.'},
 transaction:'Each original migration is atomic, versioned and retains tables before destructive changes; HNSW builds can require a longer dedicated application migration for large datasets.'
};
export function applicationMigrationStatements(plan){
 if(!plan||plan.version!==1||plan.kind!=='database'||!Array.isArray(plan.steps)||!plan.steps.length||plan.steps.length>32)fail('migration_invalid');
 return plan.steps.flatMap(s=>{
  if(!s||typeof s!=='object')fail('migration_invalid');
  if(s.operation==='create_table'){
   if(!Array.isArray(s.columns)||!s.columns.length||s.columns.length>64||new Set(s.columns.map(c=>c?.name)).size!==s.columns.length)fail('columns_invalid');
   return [{sql:'CREATE TABLE '+table(s.table)+' ('+s.columns.map(column).join(',')+')'}];
  }
  if(s.operation==='add_column')return [{sql:'ALTER TABLE '+table(s.table)+' ADD COLUMN '+column(s.column)}];
  if(s.operation==='alter_type')return [{sql:'ALTER TABLE '+table(s.table)+' ALTER COLUMN '+ident(s.column)+' TYPE '+type(s.type),backup:s.table}];
  if(s.operation==='create_index'&&(s.method!==undefined||s.operatorClass!==undefined||s.metric!==undefined||s.vectorType!==undefined)){
   const names=columns(s.columns),method=s.method??'btree';
   if(!['btree','gin','hnsw'].includes(method)||s.unique===true&&method!=='btree')fail('index_invalid');
   let suffix='';
   if(method==='hnsw'){
    const metrics={cosine:'vector_cosine_ops',l2:'vector_l2_ops',inner_product:'vector_ip_ops'};
    if(names.length!==1||!Object.hasOwn(metrics,s.metric)||s.operatorClass!==undefined||s.vectorType!==undefined&&!['vector','halfvec'].includes(s.vectorType))fail('vector_index_invalid');
    suffix=' extensions.'+metrics[s.metric].replace('vector_',s.vectorType==='halfvec'?'halfvec_':'vector_');
   }else if(method==='gin'){
    if(s.metric!==undefined||s.vectorType!==undefined||s.operatorClass!==undefined&&s.operatorClass!=='trigram'||s.operatorClass==='trigram'&&names.length!==1)fail('search_index_invalid');
    if(s.operatorClass==='trigram')suffix=' extensions.gin_trgm_ops';
   }else if(s.metric!==undefined||s.operatorClass!==undefined||s.vectorType!==undefined)fail('index_invalid');
   return [{sql:'CREATE '+(s.unique===true?'UNIQUE ':'')+'INDEX '+ident(s.name)+' ON '+table(s.table)+' USING '+method+' ('+names.join(',')+suffix+')'}];
  }
  if(s.operation==='add_text_search_column'){
   const names=columns(s.columns);if(!['simple','english','german'].includes(s.language))fail('search_language_invalid');
   const document=names.map(n=>'coalesce('+n+",'')").join(" || ' ' || ");
   return [{sql:'ALTER TABLE '+table(s.table)+' ADD COLUMN '+ident(s.name)+" tsvector GENERATED ALWAYS AS (to_tsvector('pg_catalog."+s.language+"'::regconfig,"+document+')) STORED'}];
  }
  if(s.operation==='create_cache_table'){
   const index='cache_expiry_'+createHash('sha256').update(String(s.table)).digest('hex').slice(0,20);
   return [{sql:'CREATE TABLE '+table(s.table)+' (key text PRIMARY KEY,value jsonb NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now())'},{sql:'CREATE INDEX '+ident(index)+' ON '+table(s.table)+' (expires_at)'}];
  }
  return migrationStatements({...plan,steps:[s]});
 });
}
