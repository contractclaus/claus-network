import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,manifest} from './apps-fixture.mjs';import {render} from '../hosting/render.mjs';

test('one identity across apps, MCP dispatch, private parents and scoped operator revocation',async t=>{
 const {app,owner,bob,eve,project}=await fixture(t),projectId=project.id;
 const other=await eve.call('project_create',{slug:'private-board',name:'Private board',idempotencyKey:'other'});
 await eve.call('app_configure',{projectId:other.id,manifest:{...manifest,participation:'invite'},expectedRevision:0,idempotencyKey:'configure'});
 const b=(await bob.call('principal_me')).principal.id;
 await eve.call('app_membership',{projectId:other.id,principalId:b,active:true,expectedRevision:0,idempotencyKey:'invite'});
 const one=await bob.call('app_record_create',{projectId,collection:'notes',data:{text:'private'},idempotencyKey:'note'});
 const two=await bob.call('app_record_create',{projectId:other.id,collection:'posts',data:{text:'same identity'},idempotencyKey:'post'});assert.equal(one.authorId,two.authorId);
 await assert.rejects(eve.call('app_record_create',{projectId,collection:'notes',parentId:one.id,data:{text:'probe'},idempotencyKey:'probe'}),e=>e.code==='not_found');
 const mcp=await app.fetch(new Request('https://claus.test/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'public_app',arguments:{projectId}}})}),{peer:'mcp'});const out=await mcp.json();assert.equal(out.result.structuredContent.projectId,projectId);
 const role=await owner.call('content_admin_grant',{principalId:b,active:true,scopes:['inspect','moderate','publish'],expiresAt:null,expectedRevision:0,reason:'scoped operator acceptance'});
 await assert.rejects(bob.call('content_admin_grant',{principalId:b,active:true,scopes:['inspect'],expiresAt:null,expectedRevision:role.revision,reason:'escalation'}),e=>e.code==='scope_denied');
 await bob.call('content_admin_inspect',{projectId,kind:'profile',reason:'read intent',idempotencyKey:'one-read'});
 await assert.rejects(bob.call('content_admin_inspect',{projectId,kind:'audit',reason:'changed intent',idempotencyKey:'one-read'}),e=>e.code==='idempotency_conflict');
 const correction=await bob.call('content_admin_correct',{projectId,files:[{path:'index.html',content:'<h1>Corrected</h1>'}],reason:'operator correction',expectedRevision:0,idempotencyKey:'correct'});
 const target='https://claus-network-sites.vercel.app/r/'+correction.releaseId.slice(7)+'/index.html';
 const options={apiOrigin:'https://claus.test',fetcher:(url,opt)=>app.fetch(new Request(url,opt),{peer:'hosting'})};
 assert.equal((await render(new Request(target),options)).status,200);
 await bob.call('content_admin_control',{projectId,held:true,releaseId:correction.releaseId,reason:'hold',expectedRevision:correction.revision,idempotencyKey:'hold'});
 assert.equal((await render(new Request(target),options)).status,404);
 await owner.call('content_admin_grant',{principalId:b,active:false,scopes:[],expiresAt:null,expectedRevision:role.revision,reason:'revoke'});
 await assert.rejects(bob.call('content_admin_inspect',{projectId,kind:'profile',reason:'revoked',idempotencyKey:'inspect'}),e=>e.code==='scope_denied');
});
