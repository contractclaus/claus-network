import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {randomBytes} from 'node:crypto';
import {createClient} from '../interfaces/sdk.mjs';import {createMcp} from '../interfaces/mcp.mjs';import {createApplication} from '../runtime/server.mjs';import {createProjects} from '../src/projects/index.mjs';import {openStore} from '../src/storage/index.mjs';import {digest} from '../src/shared/index.mjs';
const request=(signal)=>new Request('https://claus.si/mcp',{method:'POST',signal,headers:{accept:'application/json, text/event-stream','content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'app_events',arguments:{projectId:'p',waitMs:15000}}})});
test('MCP cancellation reaches the active event read and rate denial remains structured',async()=>{
 const stop=new AbortController();let started;const ready=new Promise(r=>started=r);const service={routes:[{name:'app_events',method:'GET'}],execute:async(_n,_i,_t,{signal})=>{started();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));return {cancelled:signal.aborted};}};
 const pending=createMcp({service})(request(stop.signal));await ready;stop.abort();assert.equal((await (await pending).json()).result.structuredContent.cancelled,true);
 const denied=await createMcp({service,admit:async()=>{throw Object.assign(Error('rate'),{code:'rate_limited',retryAfterSeconds:273});}})(request());assert.equal(denied.status,429);assert.equal(denied.headers.get('retry-after'),'273');assert.equal((await denied.json()).error.data.error,'rate_limited');
});
test('HTTP and MCP preserve the actual limiter boundary and the next window recovers',async t=>{
 const store=openStore(':memory:');t.after(()=>store.close());let now=600001;const salt='test-efficiency-rate-salt-0123456789',app=createApplication({store,rateSalt:salt,now:()=>now});
 await store.transaction(tx=>tx.write('rate-limits',digest({salt,subject:'peer',group:'api'}),{window:2,count:300,expiresAt:1200000},0));
 const a=await app.fetch(new Request('https://claus.si/v1/public/graph?view=projects'),{peer:'peer'});assert.equal(a.status,429);assert.equal(a.headers.get('retry-after'),'300');assert.equal((await a.json()).retryAfterSeconds,300);
 now=899001;const b=await app.fetch(request(),{peer:'peer'});assert.equal(b.status,429);assert.equal(b.headers.get('retry-after'),'1');
 now=900001;assert.equal((await app.fetch(new Request('https://claus.si/v1/public/graph?view=projects'),{peer:'peer'})).status,200);
});
test('SDK classifies uncertain mutation failures without replay or exposing transport diagnostics',async()=>{
 let calls=0;const client=createClient({fetch:async()=>{calls++;throw Error('secret upstream endpoint');}});
 await assert.rejects(client.call('project_create',{slug:'x',name:'X',idempotencyKey:'same'}),e=>e.outcome==='unknown'&&e.code==='transport_unavailable'&&!String(e).includes('secret'));assert.equal(calls,1);
 await assert.rejects(createClient({fetch:async()=>Response.json({error:'rate_limited',retryAfterSeconds:227},{status:429,headers:{'retry-after':'227'}})}).call('network_graph'),e=>e.retryAfterSeconds===227&&e.outcome==='read_failed');
 const stop=new AbortController();stop.abort();await assert.rejects(client.call('network_graph',{}, {signal:stop.signal}));assert.equal(calls,1);
});
test('public agents use bounded batches and never expose held, archived or stale publications',async()=>{
 const rows=['good','held','archived','foreign','unpublished'].map((id,i)=>({id:String(i),revision:1,value:{projectId:id,agentId:id,name:id,published:true}}));let reads=0,batches=0;
 const store={list:async()=>rows,read:async()=>{reads++;throw Error('N+1 read');},readMany:async(c,ids)=>{batches++;return new Map(ids.map(id=>[id,{value:c==='projects'?{id,slug:id,archivedAt:id==='archived'?1:null}:{projectId:id==='foreign'?'someone-else':id,published:id!=='unpublished'}}]));}};
 const projects=createProjects({store,identity:{},visibleMany:async ids=>new Set(ids.filter(id=>id!=='held'))});const out=await projects.publicAgents({limit:5});assert.deepEqual(out.items.map(a=>a.id),['good']);assert.equal(out.nextCursor,'4');assert.equal(reads,0);assert.equal(batches,2);
});
test('PostgreSQL admission is atomic under contention and independent of the domain lock',{skip:!process.env.NETWORK_TEST_CREDENTIAL_FILE,timeout:45000},async t=>{
 const {Pool,neonConfig}=await import('@neondatabase/serverless');neonConfig.webSocketConstructor=(await import('ws')).default;const {openPostgresStore}=await import('../src/postgres/index.mjs');
 const cfg=JSON.parse(await readFile(process.env.NETWORK_TEST_CREDENTIAL_FILE,'utf8')),schema='efficiency_'+randomBytes(6).toString('hex'),pool=new Pool({connectionString:cfg.migrationUrl,max:8,connectionTimeoutMillis:8000}),store=await openPostgresStore({pool,schema,migrate:true});
 t.after(async()=>{await pool.query(`DROP SCHEMA "${schema}" CASCADE`);await store.close();});
 const entries=[{id:'global',maximum:7},{id:'peer',maximum:3}],consume=()=>store.consumeRateLimits({entries,window:100});
 const results=await Promise.allSettled(Array.from({length:10},consume));assert.equal(results.filter(r=>r.status==='fulfilled').length,3);assert(results.filter(r=>r.status==='rejected').every(r=>r.reason.code==='rate_limited'));assert.equal((await store.read('rate-limits','global')).value.count,3);assert.equal((await store.read('rate-limits','peer')).value.count,3);
 let unlock,locked;const gate=new Promise(r=>unlock=r),ready=new Promise(r=>locked=r);const domain=store.transaction(async tx=>{await tx.write('test','financial-transition',{kept:true},0);locked();await gate;});await ready;
 try {await store.consumeRateLimits({entries,window:101});assert.equal((await store.read('rate-limits','peer')).value.count,1);}finally{unlock();await domain;}
 assert.equal((await store.read('test','financial-transition')).value.kept,true);
 const runtime=new Pool({connectionString:cfg.runtimeUrl,max:1,connectionTimeoutMillis:8000});assert.match(cfg.runtimeRole,/^[a-z][a-z0-9_]{0,62}$/);await pool.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${cfg.runtimeRole}"; GRANT SELECT,INSERT,UPDATE ON "${schema}".documents TO "${cfg.runtimeRole}";`);
 const rs=await openPostgresStore({pool:runtime,schema});try{await rs.consumeRateLimits({entries,window:101});assert.equal((await rs.read('rate-limits','global')).value.count,2);}finally{await rs.close();}
});
