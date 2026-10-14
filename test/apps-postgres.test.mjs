import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {randomBytes} from 'node:crypto';
import {Pool,neonConfig} from '@neondatabase/serverless';import ws from 'ws';
import {openPostgresStore} from '../src/postgres/index.mjs';import {openAppPostgres} from '../src/app-storage/index.mjs';import {fixture} from './apps-fixture.mjs';
neonConfig.webSocketConstructor=ws;
test('PostgreSQL app claims, committed cursors, restart, content correction and independent app locks',{skip:!process.env.NETWORK_TEST_CREDENTIAL_FILE,timeout:180000},async t=>{
 const cfg=JSON.parse(await readFile(process.env.NETWORK_TEST_CREDENTIAL_FILE,'utf8')),schema='apps_acceptance_'+randomBytes(6).toString('hex');
 const pool=new Pool({connectionString:cfg.migrationUrl,max:5,connectionTimeoutMillis:10000});const store=await openPostgresStore({pool,schema,migrate:true}),appStorage=await openAppPostgres({pool,schema,migrate:true});
 t.after(async()=>{await pool.query(`DROP SCHEMA "${schema}" CASCADE`);await pool.end();});
 assert(/^[a-zA-Z0-9_]+$/.test(cfg.runtimeRole));await pool.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${cfg.runtimeRole}";GRANT SELECT,UPDATE ON "${schema}".documents TO "${cfg.runtimeRole}";GRANT SELECT,INSERT,UPDATE ON "${schema}".app_documents TO "${cfg.runtimeRole}"`);
 const runtimePool=new Pool({connectionString:cfg.runtimeUrl,max:3});t.after(()=>runtimePool.end());const runtimeApps=await openAppPostgres({pool:runtimePool,schema});
 const {app,owner,bob,eve,project}=await fixture(t,{store,appStorage:runtimeApps}),projectId=project.id;
 const post=await bob.call('app_record_create',{projectId,collection:'posts',data:{text:'one'},idempotencyKey:'record'});
 const task=await owner.call('app_task_post',{projectId,input:{text:'claim'},idempotencyKey:'task'});
 const claims=await Promise.allSettled([bob,eve].map(c=>c.call('app_task_claim',{projectId,taskId:task.id,expectedRevision:1,idempotencyKey:'claim'})));assert.equal(claims.filter(c=>c.status==='fulfilled').length,1);
 const first=await bob.call('app_events',{projectId});const cursor=first.nextCursor;
 const restarted=await openAppPostgres({pool,schema});assert.equal((await restarted.reader(projectId).read('records:posts',post.id)).value.data.text,'one');
 await bob.call('app_record_update',{projectId,collection:'posts',recordId:post.id,data:{text:'two'},expectedRevision:post.revision,idempotencyKey:'edit'});
 const next=await bob.call('app_events',{projectId,after:cursor});assert.equal(next.items.length,1);assert(next.items[0].sequence>first.items.at(-1).sequence);
 const fixed=await owner.call('content_admin_correct',{projectId,files:[{path:'index.html',content:'<h1>Attributable correction</h1>'}],reason:'acceptance correction',expectedRevision:0,idempotencyKey:'correction'});
 assert.equal((await owner.call('public_release',{releaseId:fixed.releaseId})).administration.reason,'acceptance correction');
 const info=await owner.call('content_admin_inspect',{projectId,kind:'release',id:fixed.releaseId,reason:'verify source',idempotencyKey:'read'});assert.match(info.files[0].content,/Attributable/);
 await owner.call('content_admin_control',{projectId,held:true,releaseId:fixed.releaseId,reason:'hold',expectedRevision:fixed.revision,idempotencyKey:'hold'});
 await assert.rejects(bob.call('public_release',{releaseId:fixed.releaseId}),e=>e.code==='not_found');
 // One app lock does not block a different app's state transition.
 let release;const gate=new Promise(r=>{release=r});let acquired;const entered=new Promise(r=>{acquired=r});
 const slow=appStorage.transaction('isolated-one',async tx=>{acquired();await gate;await tx.write('meta','x',{ok:true},0);});await entered;
 await appStorage.transaction('isolated-two',tx=>tx.write('meta','x',{ok:true},0));release();await slow;
 // Representative multi-app volume: tiny tables legitimately use sequential scans.
 await pool.query(`INSERT INTO "${schema}".app_documents(app_id,collection,id,revision,body) SELECT 'other-'||(i%100),'records:posts',i::text,1,'{}'::jsonb FROM generate_series(1,20000) i; ANALYZE "${schema}".app_documents`);
 const plan=await pool.query(`EXPLAIN SELECT body FROM "${schema}".app_documents WHERE app_id=$1 AND collection=$2 AND id>$3 ORDER BY id LIMIT 50`,[projectId,'records:posts','']);
 assert.match(plan.rows.map(r=>r['QUERY PLAN']).join(' '),/Index|Bitmap/);
});
