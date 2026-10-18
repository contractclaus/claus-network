import test from 'node:test';import assert from 'node:assert/strict';
import {backupAllowance} from '../src/recovery/backup-allowance.mjs';
test('the external backup key can only prepay the bounded current week or imminent next week',async()=>{
 const day=86400000,rows=new Map(),calls=[];let time=20500*day;
 const issue=backupAllowance({store:{put:async(k,id,v)=>{if(!rows.has(id))rows.set(id,v);return {value:rows.get(id)};}},budget:async(...args)=>calls.push(args),secret:()=> 'x'.repeat(64),now:()=>time});
 const period=Math.floor(time/(7*day)),a=await issue(period),b=await issue(period);
 assert.deepEqual(a,b);assert.equal(a.allowance.maximum,11200000);assert.equal(a.allowance.slots,28);assert.equal(calls[0][1],calls[2][1]);
 await assert.rejects(issue(period-1));await assert.rejects(issue(period+2));
 time=(period+1)*7*day-1000;assert.equal((await issue(period+1)).allowance.period,period+1);
});
