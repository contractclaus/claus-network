import test from 'node:test';import assert from 'node:assert/strict';import {fixture} from './apps-fixture.mjs';import {createClient} from '../interfaces/sdk.mjs';import {subscribeAppEvents,exportApplication} from '../interfaces/app-events.mjs';
test('app sessions cannot cross apps, access projects, grant credentials or survive membership revocation',async t=>{
 const {app,owner,bob,project,advance}=await fixture(t),projectId=project.id;
 const s=await bob.call('app_session_create',{projectId,actions:['app_records','app_record_create','app_events'],expiresAt:Date.now()+900000});
 const client=createClient({origin:'https://claus.test',token:s.token,fetch:(u,o)=>app.fetch(new Request(u,o),{peer:'session'})});
 const r=await client.call('app_record_create',{projectId,collection:'posts',data:{text:'scoped'},idempotencyKey:'s1'});assert.equal(r.authorId,(await bob.call('principal_me')).principal.id);
 for(const [op,input] of [['project_create',{slug:'escape',name:'Escape',idempotencyKey:'bad'}],['app_session_create',{projectId,actions:['app_records'],expiresAt:Date.now()+900000}],['app_records',{projectId:'other',collection:'posts'}],['app_export',{projectId}]])await assert.rejects(client.call(op,input),e=>e.code==='scope_denied');
 await owner.call('app_membership',{projectId,principalId:r.authorId,active:false,expectedRevision:1,idempotencyKey:'revoke'});
 await assert.rejects(client.call('app_records',{projectId,collection:'posts'}),e=>e.code==='app_membership_required');
 await bob.call('app_session_revoke',{projectId,sessionId:s.credential.id});
 await assert.rejects(client.call('app_events',{projectId}),e=>e.status===401);
});
test('owner sessions are participants without gaining admin visibility and parent revocation fences them',async t=>{
 const {app,owner,project}=await fixture(t),projectId=project.id;
 const s=await owner.call('app_session_create',{projectId,actions:['app_records'],expiresAt:Date.now()+600000});
 const call=()=>app.service.execute('app_records',{projectId,collection:'posts'},s.token);assert.deepEqual((await call()).items,[]);
 const parent=await owner.call('principal_me');await owner.call('credential_revoke',{credentialId:parent.credential.id});await assert.rejects(call(),e=>e.code==='unauthenticated');
});
test('owner exports include private app data and open tasks, fence changed content, and deny other participants',async t=>{
 const {owner,bob,project}=await fixture(t),projectId=project.id;
 await bob.call('app_record_create',{projectId,collection:'notes',data:{text:'private'},idempotencyKey:'private'});
 await owner.call('app_task_post',{projectId,input:{text:'open work'},idempotencyKey:'task'});
 const pages=[];for await(const page of exportApplication(owner,{projectId}))pages.push(page);
 assert(pages.some(p=>p.collection==='records:notes'&&p.items.some(i=>i.data.text==='private')));assert(pages.some(p=>p.collection==='tasks'&&p.items.some(i=>i.state==='open')));
 await assert.rejects(bob.call('app_export',{projectId}),e=>['not_found','scope_denied'].includes(e.code));
 const first=await owner.call('app_export',{projectId,limit:1});await bob.call('app_record_create',{projectId,collection:'posts',data:{text:'new'},idempotencyKey:'new'});
 await assert.rejects(owner.call('app_export',{projectId,after:first.nextCursor}),e=>e.code==='app_export_changed'&&e.status===409);
});
test('subscription checkpoints commit after processing and authorization failures stop polling',async()=>{
 const calls=[],waits=[],abort=new AbortController();let n=0;
 const stream=subscribeAppEvents({call:async(name,input)=>{calls.push(input.after);n++;if(n===1)return {items:[{sequence:1}],nextCursor:'a',hasMore:false};if(n===2)throw Object.assign(Error('offline'),{status:503});if(n===3)return {items:[{sequence:2}],nextCursor:'b',hasMore:false};throw Object.assign(Error('revoked'),{status:403});}},{projectId:'p',signal:abort.signal,wait:async n=>waits.push(n)});
 assert.equal((await stream.next()).value.nextCursor,'a');assert.deepEqual(calls,[undefined]);
 assert.equal((await stream.next()).value.nextCursor,'b');assert.deepEqual(calls,[undefined,'a','a']);
 await assert.rejects(stream.next(),e=>e.status===403);assert(waits.length<5);
});

test('MCP cannot expose app session credentials and templates configure without overwriting schemas',async t=>{
 const {app,owner,project}=await fixture(t);const rpc=async(method,params)=>{const r=await app.fetch(new Request('https://claus.test/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}),{peer:'mcp'});return r.json();};
 assert(!(await rpc('tools/list',{})).result.tools.some(x=>x.name==='app_session_create'));assert.equal((await rpc('tools/call',{name:'app_session_create',arguments:{}})).error.message,'Unknown tool');
 const {configureApp}=await import('../interfaces/app.mjs'),{manifest}=await import('./apps-fixture.mjs');const unchanged=await configureApp(owner,{projectId:project.id,manifest});assert.equal(unchanged.version,1);await assert.rejects(configureApp(owner,{projectId:project.id,manifest:{...manifest,name:'Changed'}}),/different manifest/);
});
test('browser CORS permits only trusted Claus app operations, never opaque frames or project administration',async t=>{
 const {app,project}=await fixture(t),url='https://claus.test/v1/apps/'+project.id+'/sessions';
 const request=(u,origin,method='POST')=>app.fetch(new Request(u,{method:'OPTIONS',headers:{origin,'access-control-request-method':method,'access-control-request-headers':'authorization, content-type'}}),{peer:'cors'});
 const allowed=await request(url,'https://claus.si');assert.equal(allowed.status,204);assert.equal(allowed.headers.get('access-control-allow-origin'),'https://claus.si');assert.equal(allowed.headers.get('access-control-allow-credentials'),null);
 for(const origin of ['null','https://example.com'])assert.equal((await request(url,origin)).status,403);
 assert.equal((await request('https://claus.test/v1/projects','https://claus.si')).status,403);
 const rejected=await app.fetch(new Request(url,{method:'POST',headers:{origin:'https://claus.si','content-type':'application/json'},body:JSON.stringify({actions:['app_records'],expiresAt:Date.now()+600000})}),{peer:'cors'});assert.equal(rejected.status,401);assert.equal(rejected.headers.get('access-control-allow-origin'),'https://claus.si');
});
