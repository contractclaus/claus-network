import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './apps-fixture.mjs';
import {createClient} from '../interfaces/sdk.mjs';

test('task apps advertise private clarification tools to agent discovery',async t=>{
 const {owner,project}=await fixture(t);
 for(const operation of ['public_app','app_get']){
  const app=await owner.call(operation,{projectId:project.id});
  for(const name of ['app_task_message','app_task_messages'])assert(app.actions.includes(name),`${operation} omits ${name}`);
 }
});

test('task message app sessions retain party, action and membership restrictions',async t=>{
 const {app,owner,bob,eve,project}=await fixture(t),projectId=project.id;
 const task=await owner.call('app_task_post',{projectId,input:{text:'Publish a status page'},idempotencyKey:'task'});
 await bob.call('app_task_claim',{projectId,taskId:task.id,expectedRevision:task.revision,idempotencyKey:'claim'});
 const scoped=async(actor,actions)=>{
  const s=await actor.call('app_session_create',{projectId,actions,expiresAt:Date.now()+600000});
  return createClient({origin:'https://claus.test',token:s.token,fetch:(u,o)=>app.fetch(new Request(u,o),{peer:'session'})});
 };
 const writer=await scoped(bob,['app_task_message','app_task_messages']);
 const reader=await scoped(owner,['app_task_messages']);
 const outsider=await scoped(eve,['app_task_message','app_task_messages']);
 const input={projectId,taskId:task.id,body:'The page is ready for review',idempotencyKey:'clarification'};
 const sent=await writer.call('app_task_message',input);
 assert.deepEqual(await writer.call('app_task_message',input),sent);
 assert.equal((await reader.call('app_task_messages',{projectId,taskId:task.id})).items[0].body,input.body);
 await assert.rejects(reader.call('app_task_message',{...input,idempotencyKey:'read-cannot-write'}),e=>e.code==='scope_denied');
 for(const [operation,args]of [['app_task_messages',{projectId,taskId:task.id}],['app_task_message',{...input,idempotencyKey:'outsider'}]])await assert.rejects(outsider.call(operation,args),e=>e.code==='scope_denied');
 await owner.call('app_membership',{projectId,principalId:sent.authorId,active:false,expectedRevision:1,idempotencyKey:'revoke'});
 await assert.rejects(writer.call('app_task_messages',{projectId,taskId:task.id}),e=>e.code==='app_membership_required');
 await assert.rejects(writer.call('app_task_message',{...input,idempotencyKey:'revoked'}),e=>e.code==='app_membership_required');
});
