import test from 'node:test';import assert from 'node:assert/strict';
import {fixture} from './apps-fixture.mjs';
import {taskProgress} from '../src/apps/progress.mjs';

test('task discovery pages preserve query, state and original task IDs',async t=>{
 const {owner,project}=await fixture(t);const ids=[];
 for(let i=0;i<3;i++)ids.push((await owner.call('app_task_post',{projectId:project.id,input:{text:'work '+i},idempotencyKey:'task'+i})).id);
 let after='',first,found=[];for(let i=0;i<10;i++){
  const page=await owner.call('network_discover',{kind:'task',state:'open',limit:1,...(after?{after}:{})});
  first??=page.nextCursor;found.push(...page.items.map(x=>x.id));after=page.nextCursor;if(!after)break;
 }
 assert.equal(after,null);assert.deepEqual(found.sort(),ids.sort());
 await assert.rejects(owner.call('network_discover',{kind:'task',state:'accepted',after:first}),e=>e.code==='invalid_cursor');
 const one=await owner.call('public_task',{projectId:project.id,taskId:ids[0]});assert.equal(one.id,ids[0]);
 const progress=await owner.call('public_task_progress',{projectId:project.id,taskId:ids[0]});assert.equal(progress.payment.state,'not_bound');assert.equal(progress.next[0].operation,'app_task_claim');
});

test('public activity and progress enforce publication; acceptance is not payment',async t=>{
 const {owner,bob,project}=await fixture(t),p={projectId:project.id};
 let task=await owner.call('app_task_post',{...p,input:{text:'work'},idempotencyKey:'task'});
 task=await bob.call('app_task_claim',{...p,taskId:task.id,expectedRevision:task.revision,idempotencyKey:'claim'});
 task=await bob.call('app_task_deliver',{...p,taskId:task.id,expectedRevision:task.revision,idempotencyKey:'deliver',generation:task.generation,output:{text:'result'}});
 task=await owner.call('app_task_accept',{...p,taskId:task.id,expectedRevision:task.revision,idempotencyKey:'accept'});
 const events=await owner.call('public_app_activity',{...p,limit:100});
 assert.deepEqual(events.items.map(x=>x.type),['task.posted','task.claim','task.deliver','task.accept']);
 assert.equal(new Set(events.items.map(x=>x.id)).size,4);assert(!JSON.stringify(events).includes('result'));
 assert.equal((await owner.call('public_task_progress',{...p,taskId:task.id})).payment.state,'not_bound');
 const continuation=await owner.call('public_app_activity',{...p,after:events.nextCursor,limit:100});assert.equal(continuation.items.length,0);
 const app=await owner.call('app_get',p);await owner.call('app_publish',{...p,published:false,expectedRevision:app.revision,idempotencyKey:'off'});
 for(const op of ['public_app_activity','public_task','public_task_progress'])await assert.rejects(owner.call(op,{...p,...(op==='public_app_activity'?{}:{taskId:task.id})}),e=>e.code==='not_found');
});

test('payment steps separate app delivery, chain acceptance, credit and unavailable observations',()=>{
 const task={id:'t',revision:3,state:'claimed',authorId:'a',assigneeId:'b',agreement:{asset:'CLAUS',priceWei:'100',deliveryDue:100}};
 const projectId='p';let p=taskProgress(task,{state:'working',nextActions:['deliver']},{projectId});assert.equal(p.next[0].operation,'app_task_deliver');
 p=taskProgress({...task,state:'submitted'},{state:'working',nextActions:['deliver']},{projectId});assert.equal(p.next[0].action,'deliver');
 p=taskProgress({...task,state:'accepted'},{state:'submitted',nextActions:['accept']},{projectId});assert.equal(p.next[0].action,'accept');
 p=taskProgress(task,{state:'credited',nextActions:['withdraw']},{projectId});assert.equal(p.next[0].operation,'deal_balance');assert.equal(p.payment.withdrawal,'not_observed');
 p=taskProgress(task,null,{projectId,paymentError:true});assert.equal(p.phase,'payment_unknown');assert.deepEqual(p.next.map(x=>x.operation),['public_task_progress']);
});
