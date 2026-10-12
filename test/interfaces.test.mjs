import test from 'node:test';
import assert from 'node:assert/strict';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {openStore} from '../src/storage/index.mjs';
import {createApplication,listen} from '../runtime/server.mjs';
import {createClient} from '../interfaces/sdk.mjs';
import {openapi,ROUTES} from '../interfaces/contract.mjs';

async function setup(t){
 const store=openStore(':memory:');
 const application=createApplication({store,rateSalt:'test-only-ratelimit-salt-0123456789'});
 const server=await listen(application),origin='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await new Promise(r=>server.close(r));await store.close();});
 const guest=createClient({origin}),account=privateKeyToAccount(generatePrivateKey());
 const c=await guest.call('auth_challenge',{address:account.address});
 const session=await guest.call('auth_session',{challengeId:c.id,signature:await account.signMessage({message:c.message})});
 return {store,application,server,origin,guest,session,client:createClient({origin,token:session.token})};
}

test('HTTP/SDK lifecycle publishes only authorized source and profiles, then withdraws them',async t=>{
 const f=await setup(t);
 const project=await f.client.call('project_create',{slug:'api-fixture',name:'API fixture',idempotencyKey:'once'});
 const current=await f.client.call('project_get',{projectId:project.id});
 const snapshot=await f.client.call('snapshot_create',{projectId:project.id,expectedProjectRevision:current.revision,files:[{path:'src/Simple.sol',content:'pragma solidity ^0.8.27; contract Simple {}'}]});
 assert.equal((await f.guest.call('network_graph')).nodes.length,1);
 await assert.rejects(f.guest.call('snapshot_get',{projectId:project.id,snapshotId:snapshot.id}),{code:'unauthenticated'});
 const exported=await f.client.call('project_export',{projectId:project.id,snapshotId:snapshot.id});
 assert.equal(exported.files[0].path,'src/Simple.sol');
 const publication=await f.client.call('project_publish',{projectId:project.id,published:true,expectedRevision:0,description:'A public test profile'});
 const profile=await f.guest.call('public_project',{slug:project.slug});
 assert.equal(profile.name,project.name);assert.equal(profile.ownerId,undefined);
 assert.equal(profile.files,undefined);assert.deepEqual(profile.evidence.reviews,[]);
 assert.equal((await f.guest.call('network_graph')).nodes.length,2);
 const source=await f.client.call('source_publish',{projectId:project.id,snapshotId:snapshot.id,published:true,expectedRevision:0});
 assert.equal((await f.guest.call('public_source',{sourceId:source.id})).files.length,1);
 await f.client.call('source_publish',{projectId:project.id,snapshotId:snapshot.id,published:false,expectedRevision:source.revision});
 await assert.rejects(f.guest.call('public_source',{sourceId:source.id}),{code:'not_found'});
 await f.client.call('project_publish',{projectId:project.id,published:false,expectedRevision:publication.revision});
 assert.equal((await f.guest.call('network_graph')).nodes.length,1);
 await assert.rejects(f.guest.call('public_project',{slug:project.slug}),{code:'not_found'});
});

test('MCP uses the same scopes, hides credential-producing tools and preserves revocation',async t=>{
 const f=await setup(t);
 const p=await f.client.call('project_create',{slug:'mcp-fixture',name:'MCP fixture',idempotencyKey:'mcp'});
 const a=await f.client.call('agent_create',{projectId:p.id,name:'Reader'});
 const m=await f.client.call('mandate_create',{projectId:p.id,principalId:a.id,scopes:['project.read'],expiresAt:Date.now()+60000});
 const key=await f.client.call('credential_create',{mandateId:m.id});
 const call=async(method,params={},token=key.token)=>{
  const r=await fetch(f.origin+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18',authorization:'Bearer '+token},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  return r.json();
 };
 const tools=(await call('tools/list')).result.tools;
 assert.ok(tools.some(x=>x.name==='project_get'));
 assert.ok(!tools.some(x=>['credential_create','credential_rotate','auth_session'].includes(x.name)));
 const own=await call('tools/call',{name:'project_get',arguments:{projectId:p.id}});
 assert.equal(own.result.structuredContent.id,p.id);
 const denied=await call('tools/call',{name:'project_publish',arguments:{projectId:p.id,published:true,expectedRevision:0}});
 assert.equal(denied.result.isError,true);
 assert.equal(JSON.parse(denied.result.content[0].text).error,'scope_denied');
 await f.client.call('mandate_revoke',{mandateId:m.id});
 assert.equal((await call('tools/call',{name:'project_get',arguments:{projectId:p.id}})).result.isError,true);
});

test('API rejects extra fields, foreign origins and oversized input without mutation',async t=>{
 const f=await setup(t);
 await assert.rejects(f.client.call('project_create',{slug:'bad',name:'Bad',idempotencyKey:'bad',approved:true}),{code:'invalid_input'});
 const origin=await fetch(f.origin+'/v1/projects',{headers:{origin:'https://attacker.example',authorization:'Bearer '+f.session.token}});
 assert.equal(origin.status,403);
 const huge=await fetch(f.origin+'/v1/projects',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+f.session.token},body:JSON.stringify({name:'a'.repeat(301000)})});
 assert.equal(huge.status,400);
 assert.equal((await f.client.call('project_list')).items.length,0);
 const spec=await (await fetch(f.origin+'/openapi.json')).json();
 assert.deepEqual(spec,openapi({origin:'https://claus.si'}));
 assert.equal(Object.values(spec.paths).reduce((n,p)=>n+Object.keys(p).length,0),ROUTES.length);
});
