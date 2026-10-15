import test from 'node:test';import assert from 'node:assert/strict';import {fixture} from './apps-fixture.mjs';
test('private task messages keep idempotency, party boundaries and membership revocation',async t=>{
 const {owner,bob,eve,project}=await fixture(t),projectId=project.id;
 const task=await owner.call('app_task_post',{projectId,input:{text:'real work'},idempotencyKey:'task'});
 const claim=await bob.call('app_task_claim',{projectId,taskId:task.id,expectedRevision:task.revision,idempotencyKey:'claim'});
 const m={projectId,taskId:task.id,body:'Private clarification',idempotencyKey:'message'};
 const sent=await bob.call('app_task_message',m);assert.deepEqual(await bob.call('app_task_message',m),sent);
 assert.equal((await owner.call('app_task_messages',{projectId,taskId:task.id})).items.length,1);
 await assert.rejects(eve.call('app_task_messages',{projectId,taskId:task.id}),e=>e.code==='scope_denied');
 const who=(await bob.call('principal_me')).principal.id;await owner.call('app_membership',{projectId,principalId:who,active:false,expectedRevision:1,idempotencyKey:'revoke'});
 await assert.rejects(bob.call('app_task_message',m),e=>e.code==='app_membership_required');
 assert(!(await owner.call('public_app_activity',{projectId})).items.some(x=>JSON.stringify(x).includes('Private clarification')));
});
test('private message notifications preserve party boundaries and cursor recovery',async t=>{
 const {owner,bob,eve,project}=await fixture(t),projectId=project.id;
 const task=await owner.call('app_task_post',{projectId,input:{text:'event work'},idempotencyKey:'events-task'});
 await bob.call('app_task_claim',{projectId,taskId:task.id,expectedRevision:task.revision,idempotencyKey:'events-claim'});
 const before=await bob.call('app_events',{projectId});
 await owner.call('app_task_message',{projectId,taskId:task.id,body:'not public',idempotencyKey:'events-message'});
 const next=await bob.call('app_events',{projectId,after:before.nextCursor,waitMs:0});
 assert.equal(next.items[0].type,'task.message');assert(!JSON.stringify(next).includes('not public'));
 assert.deepEqual(await bob.call('app_events',{projectId,after:before.nextCursor}),next);
 assert(!(await eve.call('app_events',{projectId})).items.some(e=>e.type==='task.message'));
});
test('dependencies and project checks expose only current public relationships',async t=>{
 const {owner,bob,project}=await fixture(t),projectId=project.id;
 const other=await owner.call('project_create',{slug:'data-source',name:'Data',idempotencyKey:'data'});
 await owner.call('project_publish',{projectId:other.id,published:true,expectedRevision:0});
 const input={projectId,items:[{projectId:other.id,kind:'data',note:'Uses its public data'}],expectedRevision:0,idempotencyKey:'dependencies'};
 await owner.call('project_dependencies_set',input);assert.deepEqual((await bob.call('public_project_dependants',{projectId:other.id})).items.map(i=>i.project.id),[projectId]);
 await assert.rejects(bob.call('project_dependencies_set',input),e=>e.code==='scope_denied');
 const inspection=await bob.call('public_project_check',{slug:'agent-board'});assert.equal(inspection.projectId,projectId);assert.equal(inspection.checks.find(c=>c.id==='published-site').state,'action');
 const current=await owner.call('project_get',{projectId:other.id});await owner.call('project_publish',{projectId:other.id,published:false,expectedRevision:current.publication.revision});
 assert.equal((await bob.call('public_project_dependencies',{projectId})).items.length,0);
});
test('one-link site helper publishes, resumes and updates a real multi-page site',async t=>{
 const {publishSite}=await import('../interfaces/site.mjs');const {owner,advance}=await fixture(t);
 const input={slug:'site-helper',name:'Site',description:'An actual site',files:[{path:'index.html',content:'<h1>Hello</h1>'},{path:'about.html',content:'About'}]};
 const first=await publishSite({client:owner,...input});assert.deepEqual(await publishSite({client:owner,...input}),first);advance(1000);
 const updated=await publishSite({client:owner,...input,files:[{path:'index.html',content:'<h1>Updated</h1>'},{path:'about.html',content:'About'}]});
 assert.equal(updated.projectId,first.projectId);assert.notEqual(updated.releaseId,first.releaseId);
});
test('profiles match declared fields, are withdrawn with their project and cannot be edited by outsiders',async t=>{
 const {owner,bob,project}=await fixture(t),projectId=project.id;
 const a=await owner.call('agent_create',{projectId,name:'Reviewer',idempotencyKey:'agent'});
 await owner.call('agent_publish',{projectId,agentId:a.id,published:true,expectedRevision:0});
 const input={projectId,agentId:a.id,skills:['solidity','testing'],description:'Reviews contracts',role:'reviewer',availability:'available',quote:{asset:'CLAUS',amount:'100',unit:'per review'},published:true,expectedRevision:0,idempotencyKey:'profile'};
 const p=await owner.call('agent_work_profile_set',input);assert.deepEqual(await owner.call('agent_work_profile_set',input),p);
 await assert.rejects(bob.call('agent_work_profile_set',{...input,expectedRevision:p.revision}),e=>e.code==='scope_denied');
 assert.equal((await bob.call('public_agent_match',{skills:['solidity'],role:'reviewer',asset:'CLAUS',maxAmount:'100'})).items.length,1);
 assert.equal((await bob.call('public_agent_match',{asset:'ETH'})).items.length,0);
 const proj=await owner.call('project_get',{projectId});await owner.call('project_publish',{projectId,published:false,expectedRevision:proj.publication.revision});
 assert.equal((await bob.call('public_agent_match',{})).items.length,0);
});
test('team roles use revocable mandates without financial authority; templates do not overwrite an app',async t=>{
 const {app,owner,project}=await fixture(t),projectId=project.id;
 const a=await owner.call('agent_create',{projectId,name:'Support',idempotencyKey:'agent'});
 const grant=await owner.call('team_grant',{projectId,principalId:a.id,role:'support',expiresAt:Date.now()+60000,idempotencyKey:'team'});
 assert.deepEqual(grant.scopes,['project.read','app.use']);
 const key=await owner.call('credential_create',{mandateId:grant.id});await owner.call('mandate_revoke',{mandateId:grant.id});
 await assert.rejects(app.service.execute('app_join',{projectId,idempotencyKey:'revoked'},key.token),e=>e.code==='scope_denied');
 const templates=await owner.call('app_templates');assert.equal(templates.items.length,4);
 await assert.rejects(owner.call('app_template_install',{projectId,templateId:'jobs',idempotencyKey:'template'}),e=>e.code==='revision_conflict');
 const empty=await owner.call('project_create',{slug:'empty-app',name:'Empty',idempotencyKey:'empty'}),i={projectId:empty.id,templateId:'jobs',idempotencyKey:'template'};
 const installed=await owner.call('app_template_install',i);assert.equal(installed.application.manifest.tasks.visibility,'public');assert.deepEqual(await owner.call('app_template_install',i),installed);
});
