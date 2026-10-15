import test from 'node:test';import assert from 'node:assert/strict';import {fixture} from './apps-fixture.mjs';import {createWebhooks} from '../src/webhooks/index.mjs';import {publicIPv4,webhookSignature} from '../runtime/webhook-delivery.mjs';import {previewSite} from '../interfaces/preview.mjs';
test('structured milestones retain criteria and original tasks across retries',async t=>{
 const {owner,bob,project}=await fixture(t),projectId=project.id;
 const i={projectId,title:'Two stages',goal:'A useful product',milestones:[{title:'Spec',criteria:['Explain both states'],asset:'CLAUS',amountUnits:'100',input:{text:'Write the specification'}}],idempotencyKey:'brief'};
 const brief=await owner.call('job_brief_create',i);assert.equal((await owner.call('job_brief_create',i)).id,brief.id);
 const a=await owner.call('job_milestone_post',{projectId,briefId:brief.id,index:0}),b=await owner.call('job_milestone_post',{projectId,briefId:brief.id,index:0});assert.equal(a.task.id,b.task.id);assert.deepEqual(a.task.brief.criteria,i.milestones[0].criteria);assert(!a.task.agreement);
 await assert.rejects(bob.call('job_brief_get',{projectId,briefId:brief.id}));
 assert.equal((await owner.call('job_brief_get',{projectId,briefId:brief.id})).posted[0].taskId,a.task.id);
});
test('opt-in help and action metadata withdraw with project; outsiders cannot modify',async t=>{
 const {owner,bob,project}=await fixture(t),projectId=project.id;
 await owner.call('project_assistance_set',{projectId,enabled:true,request:'Help with onboarding',expectedRevision:0,idempotencyKey:'help'});
 assert.equal((await bob.call('public_project_assistance')).items.length,1);
 const input={projectId,actions:[{id:'read',title:'Read app',description:'Read this app',operation:'public_app',input:{projectId}}],expectedRevision:0,idempotencyKey:'actions'};
 await owner.call('project_actions_set',input);await assert.rejects(bob.call('project_actions_set',input));
 assert.equal((await bob.call('public_project_actions',{projectId})).actions[0].effects,'read');
 const p=await owner.call('project_get',{projectId});await owner.call('project_publish',{projectId,published:false,expectedRevision:p.publication.revision});assert.equal((await bob.call('public_project_assistance')).items.length,0);await assert.rejects(bob.call('public_project_actions',{projectId}));
});
test('private site previews are isolated; restore changes selection without changing app records',async t=>{
 const {owner,bob,project,advance}=await fixture(t),projectId=project.id;
 const build=async text=>{const p=await owner.call('project_get',{projectId});const s=await owner.call('snapshot_create',{projectId,files:[{path:'index.html',content:text}],expectedProjectRevision:p.revision});return owner.call('release_create',{projectId,snapshotId:s.id,paths:['index.html']});};
 const first=await build('<h1>First</h1>');await assert.rejects(bob.call('release_preview',{projectId,releaseId:first.id}));
 const preview=await previewSite({client:owner,projectId,releaseId:first.id});t.after(()=>preview.close());const r=await fetch(preview.url);assert.match(await r.text(),/First/);assert.match(r.headers.get('content-security-policy'),/connect-src 'none'/);
 await assert.rejects(owner.call('public_release',{releaseId:first.id}));
 await owner.call('release_publish',{projectId,releaseId:first.id,published:true,expectedRevision:0});advance(1000);const second=await build('<h1>Second</h1>');await owner.call('release_publish',{projectId,releaseId:second.id,published:true,expectedRevision:0});
 const before=await owner.call('release_get',{projectId,releaseId:first.id});const input={projectId,releaseId:first.id,expectedRevision:before.selection.revision,idempotencyKey:'restore'};const restored=await owner.call('release_restore',input);assert.deepEqual(await owner.call('release_restore',input),restored);assert.equal((await owner.call('public_project',{slug:project.slug})).releases[0].id,first.id);assert.equal((await owner.call('app_get',{projectId})).manifest.name,'Agent board');
});
test('webhook retries preserve delivery id; revocation prevents next send',async t=>{
 const {app,owner,project,store,advance}=await fixture(t),projectId=project.id;const sub=await owner.call('webhook_create',{projectId,url:'https://hooks.example.com/events',idempotencyKey:'one'});
 assert(sub.signingSecret);assert(!(await owner.call('webhook_list',{projectId})).items[0].signingSecret);
 await owner.call('app_task_post',{projectId,input:{text:'A public task'},idempotencyKey:'post'});
 let fail=true;const sent=[];const hooks=createWebhooks({store,identity:app.identity,apps:app.apps,admit:async()=>{},deriveSecret:()=>sub.signingSecret,now:()=>Date.now()+offset,deliver:async p=>{sent.push(p);if(fail)throw Error('timeout');}});let offset=0;
 await hooks.advance(sub.id);offset=300000;fail=false;await hooks.advance(sub.id);assert.equal(sent.length,2);assert.equal(sent[0].id,sent[1].id);assert.equal(sent[0].body,sent[1].body);
 await owner.call('webhook_revoke',{projectId,webhookId:sub.id});offset+=300000;await hooks.advance(sub.id);assert.equal(sent.length,2);
});
test('webhook network destination rejects private and reserved IPv4 ranges',()=>{for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','100.64.0.1','192.168.1.1','198.18.0.1','203.0.113.1','224.0.0.1'])assert.equal(publicIPv4(ip),false,ip);assert(publicIPv4('1.1.1.1'));assert.notEqual(webhookSignature('key',1,'id','body'),webhookSignature('key',2,'id','body'));});
test('project check finds missing local assets without executing source',async t=>{const {owner,project}=await fixture(t),projectId=project.id;const s=await owner.call('snapshot_create',{projectId,files:[{path:'index.html',content:'<h1>App</h1><script src="missing.js"></script>'}],expectedProjectRevision:(await owner.call('project_get',{projectId})).revision});const r=await owner.call('release_create',{projectId,snapshotId:s.id,paths:['index.html']});await owner.call('release_publish',{projectId,releaseId:r.id,published:true,expectedRevision:0});const checks=await owner.call('public_project_check',{slug:project.slug});assert.equal(checks.checks.find(c=>c.id==='local-links').state,'action');});
