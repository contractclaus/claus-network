import test from 'node:test';import assert from 'node:assert/strict';import {readFile,writeFile}from'node:fs/promises';import {randomBytes}from'node:crypto';import {setTimeout as delay}from'node:timers/promises';
import {Pool,neonConfig}from'@neondatabase/serverless';import ws from'ws';
import {openPostgresStore}from'../src/postgres/index.mjs';import{directoryIndexMigration,publicDirectoryQuery}from'../src/postgres/search.mjs';import{createDiscovery}from'../src/discovery/index.mjs';import{executionEvidence}from'../src/discovery/execution.mjs';import{createProjects}from'../src/projects/index.mjs';
neonConfig.webSocketConstructor=ws;
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const bounded=p=>Promise.race([p,delay(10000).then(()=>{throw Error('barrier timeout');})]);
test('PostgreSQL scoped publication, literal indexed discovery and withdrawal',{skip:!process.env.NETWORK_TEST_CREDENTIAL_FILE,timeout:120000},async t=>{
 const k=JSON.parse(await readFile(process.env.NETWORK_TEST_CREDENTIAL_FILE,'utf8')),schema='structure_'+randomBytes(6).toString('hex');
 const pool=new Pool({connectionString:k.migrationUrl,max:6,connectionTimeoutMillis:10000}),store=await openPostgresStore({pool,schema,migrate:true});
 t.after(async()=>{await pool.query(`DROP SCHEMA "${schema}" CASCADE`);await store.close();});
 await t.test('independent project publications overlap; scoped writes cannot touch global money',async()=>{
  const hold=gate(),enteredA=gate(),enteredB=gate();
  const a=store.transaction(async tx=>{enteredA.resolve();await hold.promise;await tx.write('public-projects','a',{projectId:'a',published:true},0);},{projectId:'a'});
  await bounded(enteredA.promise);
  const b=store.transaction(async tx=>{enteredB.resolve();await hold.promise;await tx.write('public-projects','b',{projectId:'b',published:true},0);},{projectId:'b'});
  try{await bounded(enteredB.promise);}finally{hold.resolve();await Promise.all([a,b]);}
  await assert.rejects(store.transaction(tx=>tx.write('balances','shared',{projectId:'a',balance:9},0),{projectId:'a'}),e=>e.code==='invalid_project_transaction_write');
  await assert.rejects(store.transaction(tx=>tx.write('public-projects','foreign',{projectId:'b'},0),{projectId:'a'}),e=>e.code==='invalid_project_transaction_write');
  assert.equal(await store.read('balances','shared'),null);
 });
 async function blockedKey(key,seed){for(let n=0;n<30;n++){const q=await pool.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted AND classid=((hashtextextended($1,$2::bigint)>>32)&4294967295)::oid AND objid=(hashtextextended($1,$2::bigint)&4294967295)::oid AND objsubid=1`,[key,seed]);if(q.rows[0].n)return;await delay(30);}throw Error('expected blocked advisory lock');}
 await t.test('same-project publication waits and global revocation is ordered with it',async()=>{
  const hold=gate(),entered=gate();let secondEntered=false;
  const first=store.transaction(async()=>{entered.resolve();await hold.promise;},{projectId:'same'});await entered.promise;
  const second=store.transaction(async()=>{secondEntered=true;},{projectId:'same'});
  try{await blockedKey(schema+':project:same',1);assert.equal(secondEntered,false);}finally{hold.resolve();await Promise.all([first,second]);}
  const hold2=gate(),entered2=gate();let globalEntered=false;
  const local=store.transaction(async()=>{entered2.resolve();await hold2.promise;},{projectId:'same'});await entered2.promise;
  const global=store.transaction(async tx=>{globalEntered=true;await tx.write('revocations','owner',{revoked:true},0);});
  try{await blockedKey(schema,0);assert.equal(globalEntered,false);}finally{hold2.resolve();await Promise.all([local,global]);}
  const projects=createProjects({store,identity:{authorize:async(a,b,c,tx)=>assert.equal(await tx.read('revocations','owner'),null,'revoked')}});
  await assert.rejects(projects.publish('owner','same',{published:true,expectedRevision:0}),/revoked/);
 });
 await t.test('global writer blocks subsequent scoped publication until commit',async()=>{
  const hold=gate(),entered=gate();let localEntered=false;
  const global=store.transaction(async()=>{entered.resolve();await hold.promise;});await entered.promise;
  const local=store.transaction(async()=>{localEntered=true;},{projectId:'new'});
  try{await blockedKey(schema,0);assert.equal(localEntered,false);}finally{hold.resolve();await Promise.all([global,local]);}
 });
 await pool.query(`INSERT INTO "${schema}".documents(collection,id,revision,body)
 SELECT 'projects','p'||i,1,jsonb_build_object('id','p'||i,'slug','s'||lpad(i::text,5,'0')) FROM generate_series(1,5000) i;
 INSERT INTO "${schema}".documents(collection,id,revision,body)
 SELECT 'public-projects','s'||lpad(i::text,5,'0'),1,jsonb_build_object('projectId','p'||i,'slug','s'||lpad(i::text,5,'0'),'name',CASE WHEN i=4999 THEN 'Rarexyz Observatory' WHEN i=4000 THEN '100%_\\real' ELSE 'Ordinary project '||i END,'description','public profile','published',true) FROM generate_series(1,5000) i;`);
 await pool.query(directoryIndexMigration(schema,{concurrently:false}));await pool.query(`ANALYZE "${schema}".documents`);
 const discovery=createDiscovery({store});
 await t.test('indexed search finds a late result on page one and actually uses the trigram index',async()=>{
  const result=await discovery.search({kind:'project',query:'RAREXYZ',limit:1});assert.equal(result.items[0].projectId,'p4999');assert.equal(result.nextCursor,null);assert.equal(result.search.method,'database-filtered');
  const query=publicDirectoryQuery(schema,{kind:'project',query:'Rarexyz',limit:1}),plan=(await pool.query('EXPLAIN (ANALYZE, FORMAT JSON) '+query.sql,query.params)).rows;
  assert(JSON.stringify(plan).includes('documents_public_search'));
  if(process.env.NETWORK_STRUCTURE_PLAN_FILE)await writeFile(process.env.NETWORK_STRUCTURE_PLAN_FILE,JSON.stringify(plan,null,2));
  const literal=await discovery.search({kind:'project',query:'100%_\\real'});assert.deepEqual(literal.items.map(x=>x.projectId),['p4000']);
 });
 await t.test('pages preserve cursors and reject query/kind mismatch',async()=>{
  const a=await discovery.search({kind:'project',query:'Ordinary',limit:2}),b=await discovery.search({kind:'project',query:'Ordinary',after:a.nextCursor,limit:2});assert.equal(a.items.length,2);assert.equal(b.items.length,2);assert(!a.items.some(x=>b.items.some(y=>y.id===x.id)));
  await assert.rejects(discovery.search({kind:'agent',query:'Ordinary',after:a.nextCursor}),e=>e.code==='invalid_cursor');
  await assert.rejects(discovery.search({kind:'project',query:'different',after:a.nextCursor}),e=>e.code==='invalid_cursor');
 });
 const projects=createProjects({store,identity:{authorize:async()=>{}}});
 await t.test('published holds, archives and withdrawals disappear without index backfill',async()=>{
  await store.transaction(tx=>tx.write('content-controls','p4999',{held:true},0));assert.equal((await discovery.search({query:'Rarexyz'})).items.length,0);
  await store.transaction(tx=>tx.write('content-controls','p4999',{held:false},1));
  await store.transaction(tx=>tx.write('projects','p4999',{id:'p4999',slug:'s04999',name:'Rarexyz Observatory',archivedAt:1},1));assert.equal((await discovery.search({query:'Rarexyz'})).items.length,0);
  await store.transaction(tx=>tx.write('projects','p4999',{id:'p4999',slug:'s04999',name:'Rarexyz Observatory'},2));
  await projects.publish('owner','p4999',{published:false,expectedRevision:1});assert.equal((await discovery.search({query:'Rarexyz'})).items.length,0);
  await projects.publish('owner','p4999',{published:true,expectedRevision:2,description:'changed immediately'});assert.equal((await discovery.search({query:'changed immediately'})).items.length,1);
  await store.transaction(tx=>tx.write('public-projects','alias',{projectId:'p4999',slug:'alias',published:true,name:'Ghostxyz'},0));assert.equal((await discovery.search({query:'Ghostxyz'})).items.length,0);
 });
 await t.test('agent search retains project visibility and offers evidence without inventing runtime presence',async()=>{
  await store.transaction(tx=>tx.write('principals','a1',{kind:'agent',projectId:'p4999',name:'Navigatorxyz'},0));
  await projects.publishAgent('owner','p4999',{agentId:'a1',published:true,expectedRevision:0});
  const absent=await discovery.search({kind:'agent',query:'Navigatorxyz'});assert.equal(absent.items[0].next,undefined);
  await store.transaction(tx=>tx.write('agent-work-profiles','p4999:a1',{projectId:'p4999',agentId:'a1',published:true},0));
  const result=await discovery.search({kind:'agent',query:'Navigatorxyz'});assert.equal(result.items.length,1);assert.equal(result.items[0].runtime.state,'unverified');assert.deepEqual(result.items[0].next,{operation:'public_agent_portfolio',input:{projectId:'p4999',agentId:'a1'}});
  await projects.publish('owner','p4999',{published:false,expectedRevision:3});assert.equal((await discovery.search({kind:'agent',query:'Navigatorxyz'})).items.length,0);
 });
 await t.test('runtime role can read search and publication without extra authority',async()=>{
  assert.match(k.runtimeRole,/^[a-z][a-z0-9_]+$/);await pool.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${k.runtimeRole}"; GRANT SELECT,INSERT,UPDATE ON "${schema}".documents TO "${k.runtimeRole}"; GRANT INSERT ON "${schema}".events TO "${k.runtimeRole}"; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${k.runtimeRole}";`);
  const rp=new Pool({connectionString:k.runtimeUrl,max:1}),rs=await openPostgresStore({pool:rp,schema});try{assert.equal((await rs.searchPublicDirectory({kind:'project',query:'100%_\\real',limit:1})).items.length,1);await rs.transaction(tx=>tx.write('public-projects','runtime',{projectId:'runtime'},0),{projectId:'runtime'});await assert.rejects(rp.query(`DELETE FROM "${schema}".documents WHERE false`),{code:'42501'});}finally{await rs.close();}
 });
});
test('execution evidence distinguishes outcomes, lease expiry and private data',async()=>{
 const at=200000000,rows=[{state:'completed',finishedAt:at-1,inputJson:'secret'},{state:'completed',finishedAt:at-90000000},{state:'failed',finishedAt:at-2},{state:'unknown',finishedAt:at-3},{state:'running',lease:{until:at-4}},{state:'queued'},{state:'completed',finishedAt:at+100}].map(value=>({value}));
 const result=await executionEvidence({workerExecutionStates:async()=>rows,list:()=>{throw Error('must not read full records')}},at);assert.equal(result.lastCompletedAt,at-1);assert.equal(result.window.finished.completed,1);assert.equal(result.window.finished.failed,1);assert.equal(result.window.finished.unknown,1);assert.equal(result.overdueLeases,1);assert.equal(result.totals.completed,3);assert(!JSON.stringify(result).includes('secret'));
 assert.equal((await executionEvidence({workerExecutionStates:async()=>Array(1001).fill({value:{state:'completed',finishedAt:1}})},at)).coverage.complete,false);
 await assert.rejects(executionEvidence({workerExecutionStates:async()=>{throw Error('unavailable')}},at),/unavailable/);
});
