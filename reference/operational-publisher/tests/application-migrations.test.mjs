import test from 'node:test';
import assert from 'node:assert/strict';
import {applicationMigrationStatements} from '../src/resources/application-migrations.mjs';
import {resourceDatabase} from '../src/resources/database.mjs';
import {migrationStatements} from '../src/website-admin/database.mjs';
const plan=steps=>({version:1,kind:'database',steps});
test('owned application supports typed vectors, full text, trigram and expiring cache storage',()=>{
 const statements=applicationMigrationStatements(plan([
  {operation:'create_table',table:'documents',columns:[{name:'id',type:'uuid',primary:true},{name:'body',type:'text'},{name:'embedding',type:'vector(1536)'}]},
  {operation:'create_index',name:'semantic',table:'documents',columns:['embedding'],method:'hnsw',metric:'cosine'},
  {operation:'add_text_search_column',table:'documents',name:'search',columns:['body'],language:'german'},
  {operation:'create_index',name:'full_text',table:'documents',columns:['search'],method:'gin'},
  {operation:'create_index',name:'trigrams',table:'documents',columns:['body'],method:'gin',operatorClass:'trigram'},
  {operation:'create_cache_table',table:'cache'}
 ]));
 assert.equal(statements.length,7);
 assert.match(statements[0].sql,/extensions\.vector\(1536\)/);
 assert.match(statements[1].sql,/USING hnsw \("embedding" extensions\.vector_cosine_ops\)/);
 assert.match(statements[2].sql,/GENERATED ALWAYS AS.*pg_catalog.german.*STORED/);
 assert.match(statements[3].sql,/USING gin \("search"\)/);
 assert.match(statements[4].sql,/extensions\.gin_trgm_ops/);
 assert.match(statements[5].sql,/expires_at timestamptz NOT NULL/);
 assert.match(statements[6].sql,/\(expires_at\)/);
 const half=applicationMigrationStatements(plan([{operation:'add_column',table:'documents',column:{name:'large_embedding',type:'halfvec(3072)'}},{operation:'create_index',name:'large_semantic',table:'documents',columns:['large_embedding'],method:'hnsw',metric:'cosine',vectorType:'halfvec'}]));
 assert.match(half[0].sql,/extensions\.halfvec\(3072\)/);assert.match(half[1].sql,/extensions\.halfvec_cosine_ops/);
 assert.throws(()=>migrationStatements(plan([{operation:'add_column',table:'documents',column:{name:'embedding',type:'vector(1536)'}}])),/website_column_type_invalid/);
});
test('SQL fragments, unsupported vector parameters and incompatible index types are rejected',()=>{
 for(const type of ['vector(0)','vector(16001)','vector(2);DROP SCHEMA public','public.vector(2)'])assert.throws(()=>applicationMigrationStatements(plan([{operation:'add_column',table:'docs',column:{name:'x',type}}])),/resource_database_/);
 for(const step of [
  {operation:'create_cache_table',table:'x;drop'},
  {operation:'create_index',name:'x',table:'docs',columns:['vector'],method:'hnsw',metric:'cosine);drop'},
  {operation:'create_index',name:'x',table:'docs',columns:['vector'],method:'hnsw',metric:'cosine',unique:true},
  {operation:'create_index',name:'x',table:'docs',columns:['a','b'],method:'gin',operatorClass:'trigram'},
  {operation:'add_text_search_column',table:'docs',name:'x',columns:['body'],language:'custom;select'},
 ])assert.throws(()=>applicationMigrationStatements(plan([step])),/resource_database_/);
});
test('new migrations retain original ID semantics and remain bound to the owned schema',async()=>{
 const id='res_'+'a'.repeat(24),schema='app_'+'a'.repeat(24),queries=[];
 let saved=null;
 const pool={connect:async()=>({query:async(q,p=[])=>{queries.push(q);if(q.startsWith('SELECT source_hash,result'))return {rows:saved?[saved]:[]};if(q.startsWith('INSERT INTO'))saved={source_hash:p[1],result:JSON.parse(p[2])};return {rows:[]};},release(){}}),end:async()=>{}};
 const database=resourceDatabase({poolFactory:()=>pool});
 const connection='postgresql://claus_app_'+ 'a'.repeat(24)+':private@localhost/claus_applications';
 const input=plan([{operation:'create_cache_table',table:'cache'}]);
 const first=await database.migrate(id,connection,'act_original','source_hash',input);
 assert.equal(first.schema,schema);assert.equal(first.steps,2);
 const creates=queries.filter(q=>q.startsWith('CREATE')).length;
 const again=await database.migrate(id,connection,'act_original','source_hash',input);
 assert.deepEqual(again,first);assert.equal(queries.filter(q=>q.startsWith('CREATE')).length,creates);
 assert(queries.some(q=>q.startsWith('CREATE TABLE "'+schema+'"."cache"')));
 assert(!queries.some(q=>q.includes('claus_website.')));
 await assert.rejects(database.migrate(id,connection,'act_original','changed_hash',input),/migration_conflict/);
 await assert.rejects(database.migrate(id,connection.replace('claus_app_','foreign_'),'act_other','other',input),/binding_invalid/);
});
