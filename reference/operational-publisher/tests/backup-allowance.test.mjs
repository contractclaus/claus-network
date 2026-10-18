import test from 'node:test';import assert from 'node:assert/strict';
import {backupAllowance} from '../src/recovery/backup-allowance.mjs';
test('backup funding uses a stable forty-cent slot and cannot prepay outside the next day',async()=>{
 const rows=new Map(),calls=[],now=Date.parse('2026-10-18T06:30:00Z');
 const issue=backupAllowance({store:{put:async(k,id,v)=>{if(!rows.has(id))rows.set(id,v);return {value:rows.get(id)};}},budget:async(...args)=>calls.push(args),secret:()=> 'x'.repeat(64),now:()=>now});
 const slot=Math.floor(now/21600000),a=await issue(slot),b=await issue(slot);assert.deepEqual(a,b);assert.equal(a.allowance.maximum,400000);assert.equal(a.allowance.slots,1);assert.equal(calls[0][1],calls[2][1]);assert(calls.every(c=>c[2]==='400000'));
 await issue(slot+3);await assert.rejects(issue(slot-1));await assert.rejects(issue(slot+4));
 const blocked=backupAllowance({store:{put:async(k,id,v)=>({value:v})},budget:async()=>{throw Error('exhausted');},secret:()=> 'x'.repeat(64),now:()=>now});await assert.rejects(blocked(slot));
});
