import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {createNetworkOperations,networkWorkQueue,validateWork} from '../src/network-operations.js';

test('durable work accepts more than twelve tasks, rejects cycles and retains revisions',async()=>{
 const db=new PGlite();
 const query:any=async(strings:TemplateStringsArray,...values:any[])=>{
  const text=strings.reduce((s,v,i)=>s+(i?'$'+i:'')+v,'');return (await db.query(text,values)).rows;
 };
 query.query=async(text:string,values:any[]=[]) => (await db.query(text,values)).rows;
 const work=createNetworkOperations({database:()=>query});
 try{
  for(let i=0;i<14;i++)await work.tool({action:'plan',id:'nw_task_'+i,title:'Task '+i,goal:'Existing useful goal',nextStep:'Continue original work'});
  await work.tool({action:'update',id:'nw_task_1',expectedRevision:1,status:'ready',dependsOn:['nw_task_0'],parentId:'nw_task_0'});
  await assert.rejects(work.tool({action:'update',id:'nw_task_0',expectedRevision:1,status:'ready',dependsOn:['nw_task_1']}),/dependency_cycle/);
  await assert.rejects(work.tool({action:'update',id:'nw_task_0',expectedRevision:1,status:'ready',parentId:'nw_task_1'}),/parent_cycle/);
  await assert.rejects(db.query("UPDATE claus_network_work SET status='completed' WHERE id='nw_task_1'"),/dependencies_unfinished/);
  const history=await work.tool({action:'history',id:'nw_task_1'});
  assert.equal(history.items.length,2);assert.deepEqual(history.items[0].snapshot.dependencies,['nw_task_0']);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM claus_network_work')).rows[0].n,14);
  const first=await work.read('nw_task_1');assert.deepEqual(first.items[0].dependency_blockers,['nw_task_0']);
  const queue=networkWorkQueue(first.items);assert.equal(queue.focus,null);assert.deepEqual(queue.queue.blocked,['nw_task_1']);
  await db.query("UPDATE claus_network_work SET status='completed',revision=revision+1 WHERE id='nw_task_0'");
  const unblocked=await work.read('nw_task_1');assert.deepEqual(unblocked.items[0].dependency_blockers,[]);assert.equal(networkWorkQueue(unblocked.items).focus?.id,'nw_task_1');
 }finally{await db.close();}
});

test('result stages need source evidence and plans cannot claim a finished result',()=>{
 assert.throws(()=>validateWork({action:'plan',id:'nw_x',title:'x',goal:'x',nextStep:'x',resultStage:'used'}),/has_no_result/);
 assert.throws(()=>validateWork({action:'update',id:'nw_x',expectedRevision:1,status:'ready',resultStage:'used'}),/evidence_required/);
 assert.throws(()=>validateWork({action:'plan',id:'nw_x',title:'x',goal:'x',nextStep:'x',dependsOn:['nw_x']}),/dependencies/);
});
