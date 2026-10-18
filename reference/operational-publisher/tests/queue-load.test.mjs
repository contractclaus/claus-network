import test from 'node:test';
import assert from 'node:assert/strict';
import {queueLoad} from '../src/infrastructure/queue-load.mjs';
test('queue load binds the real work identity, preserves unsettled activity and detects inactive work',async()=>{
 let status='working';const q={id:'res_'+'a'.repeat(24),workId:'nw_task',enabled:true};
 const read=queueLoad({store:{get:async()=>q,queueLoad:async()=>({backlog:5,busy:2})},workStatus:async()=>status,now:()=>1000});
 assert.deepEqual(await read({queueId:q.id,workId:q.workId}),{queueId:q.id,workId:q.workId,backlog:5,busy:2,enabled:true,observedAt:1000,authority:'custody-queue-state',meaning:'Eligible delivery backlog and unresolved/accepted activity. HTTP acceptance remains busy until separately resolved; it is not job completion.'});
 status='completed';assert.equal((await read({queueId:q.id,workId:q.workId})).enabled,false);
 await assert.rejects(read({queueId:q.id,workId:'nw_other'}),/scope/);
});
