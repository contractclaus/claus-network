import test from 'node:test';import assert from 'node:assert/strict';
import {openStore} from '../src/storage/index.mjs';import {createIdentity} from '../src/identity/index.mjs';
test('expired owner login preserves immutable build access without extending caller rights or revocations',async t=>{
 const store=openStore(':memory:');t.after(()=>store.close());let enabled=true,at=2000;
 await store.transaction(async tx=>{await tx.write('credentials','owner-session',{kind:'owner',principalId:'owner',expiresAt:1000,createdAt:0,revokedAt:null},0);await tx.write('projects','p',{ownerId:'owner'},0);});
 const identity=createIdentity({store,now:()=>at,writesEnabled:async()=>enabled});
 assert.equal(await identity.allowed('owner-session','build.compile',{projectId:'p'}),false);
 assert.equal(await identity.publishedBuildAllowed('owner-session','p'),true);
 assert.equal(await identity.ongoingInfrastructureAllowed('owner-session','p'),true);
 await assert.rejects(identity.authorize('owner-session','build.compile',{projectId:'p'}));
 enabled=false;assert.equal(await identity.publishedBuildAllowed('owner-session','p'),false);enabled=true;
 const update=async(collection,id,patch)=>store.transaction(async tx=>{const r=await tx.read(collection,id);await tx.write(collection,id,{...r.value,...patch},r.revision);});
 await update('projects','p',{ownerId:'other'});assert.equal(await identity.publishedBuildAllowed('owner-session','p'),false);await update('projects','p',{ownerId:'owner',transfer:{pending:true}});assert.equal(await identity.publishedBuildAllowed('owner-session','p'),false);await update('projects','p',{transfer:null});
 await store.transaction(tx=>tx.write('project-access','p',{suspended:true},0));assert.equal(await identity.publishedBuildAllowed('owner-session','p'),false);await update('project-access','p',{suspended:false});
 await update('credentials','owner-session',{revokedAt:1500});assert.equal(await identity.publishedBuildAllowed('owner-session','p'),false);assert.equal(await identity.ongoingInfrastructureAllowed('owner-session','p'),false);
 await update('credentials','owner-session',{revokedAt:null,kind:'agent'});assert.equal(await identity.publishedBuildAllowed('owner-session','p'),false);
 await store.transaction(async tx=>{await tx.write('credentials','agent-key',{kind:'agent',projectId:'p',principalId:'agent',mandateId:'m',scopes:['build.compile'],expiresAt:3000},0);await tx.write('mandates','m',{projectId:'p',principalId:'agent',ownerId:'owner',scopes:['build.compile'],expiresAt:3000},0);});
 assert.equal(await identity.publishedBuildAllowed('agent-key','p'),true);at=4000;assert.equal(await identity.publishedBuildAllowed('agent-key','p'),false);
});
