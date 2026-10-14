import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile,writeFile,stat,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {fixture} from './apps-fixture.mjs';import {exportRecovery,restoreRecovery,inspectRecovery} from '../interfaces/recovery.mjs';
async function folders(t){const root=await mkdtemp(path.join(os.tmpdir(),'claus-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));return {root,backup:root+'/backup',restored:root+'/restore'};}
test('owner export restores source, private app records and pending tasks offline without active authority',async t=>{
 const {owner,bob,project}=await fixture(t),{backup,restored}=await folders(t),projectId=project.id;
 await bob.call('app_record_create',{projectId,collection:'notes',data:{text:'private note'},idempotencyKey:'note'});
 await owner.call('app_task_post',{projectId,input:{text:'pending work'},idempotencyKey:'work'});
 const current=await owner.call('project_get',{projectId});await owner.call('snapshot_create',{projectId,expectedProjectRevision:current.revision,files:[{path:'index.html',content:'<p>hello</p>'},{path:'nested/info.html',content:'<p>subpage</p>'}]});
 const exported=await exportRecovery(owner,{projectId,directory:backup});assert(exported.sourceSnapshot);assert(exported.hasApp);
 const result=await restoreRecovery({directory:backup,destination:restored});assert.equal(result.files,2);assert.equal(result.mode,'offline-history-only');assert.equal(await readFile(restored+'/source/nested/info.html','utf8'),'<p>subpage</p>');
 const db=new DatabaseSync(restored+'/application.sqlite',{readOnly:true});t.after(()=>db.close());assert.equal(JSON.parse(db.prepare("SELECT value FROM records WHERE collection='records:notes'").get().value).data.text,'private note');assert.equal(JSON.parse(db.prepare("SELECT value FROM records WHERE collection='tasks'").get().value).state,'open');assert.equal(JSON.parse(db.prepare("SELECT value FROM metadata WHERE id='restore'").get().value).executors,false);
 assert.equal((await stat(restored+'/application.sqlite')).mode&0o777,0o600);assert.equal((await stat(backup)).mode&0o777,0o700);assert.equal((await inspectRecovery(restored)).projectId,projectId);
 await assert.rejects(exportRecovery(owner,{projectId,directory:backup}),e=>e.code==='EEXIST');await assert.rejects(restoreRecovery({directory:backup,destination:restored}),e=>e.code==='EEXIST');
});
test('changed, truncated and cross-project data cannot produce a successful restore or overwrite source',async t=>{
 const {owner,bob,project}=await fixture(t),{backup,root}=await folders(t),projectId=project.id;
 await exportRecovery(owner,{projectId,directory:backup});const original=await readFile(backup+'/bundle.ndjson','utf8');
 await writeFile(backup+'/bundle.ndjson',original.replace('Agent board','Fake board'));
 await assert.rejects(restoreRecovery({directory:backup,destination:root+'/bad'}));await assert.rejects(inspectRecovery(root+'/bad'),/incomplete_recovery_bundle/);
 await writeFile(backup+'/bundle.ndjson',original.split('\n').slice(0,-2).join('\n')+'\n');await assert.rejects(restoreRecovery({directory:backup,destination:root+'/short'}),/incomplete_recovery_bundle/);
 const before=owner.call.bind(owner);let n=0;const unstable={call:async(name,input,opt)=>{const r=await before(name,input,opt);if(name==='app_export'&&++n===1)await bob.call('app_record_create',{projectId,collection:'posts',data:{text:'changed'},idempotencyKey:'changed'});return r;}};
 await assert.rejects(exportRecovery(unstable,{projectId,directory:root+'/unstable'}),e=>e.code==='app_export_changed');assert(await stat(root+'/unstable/INCOMPLETE.txt'));
 await assert.rejects(exportRecovery(bob,{projectId,directory:root+'/foreign'}),e=>['scope_denied','not_found'].includes(e.code));
});
