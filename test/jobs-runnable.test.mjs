import test from 'node:test';
import assert from 'node:assert/strict';
import {createJobs} from '../src/jobs/index.mjs';
const now=100000;
for (const [name,makeJobs] of [['workflow',createJobs]]) {
 function fixture() {
  const rows=new Map(); const key=(c,id)=>c+':'+id;
  const tx={
   read:async(c,id)=>structuredClone(rows.get(key(c,id))??null),
   write:async(c,id,value,revision)=>{const old=rows.get(key(c,id));assert.equal(old?.revision??0,revision);const next={id,revision:revision+1,value:structuredClone(value)};rows.set(key(c,id),next);return next;},
   event:async()=>{},
   list:async()=>{throw Error('Unfiltered history scan is not allowed in this fixture')},
   listRunnableJobs:async({kinds,after='',limit,at})=>[...rows.entries()].filter(([k,r])=>k.startsWith('workflow-jobs:')&&r.id>after&&kinds.includes(r.value.kind)&&['queued','running','waiting'].includes(r.value.state)&&r.value.availableAt<=at&&(!r.value.lease||r.value.lease.until<=at)).map(([,r])=>structuredClone(r)).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,limit)
  };
  const add=(id,overrides={})=>rows.set(key('workflow-jobs',id),{id,revision:1,value:{id,projectId:'original-project',kind:'review-execute',state:'waiting',effect:'outcome_unknown',effectKey:'original-payment-'+id,payload:{originalCase:'case-'+id},authority:{original:'reserved'},attempts:4,availableAt:now-1,lease:null,...overrides}});
  return {add,rows,tx,jobs:makeJobs({store:{transaction:async fn=>fn(tx)},now:()=>now})};
 }
 test(name+': due paid review is reconciled despite 3000 historical jobs',async()=>{
  const f=fixture();for(let n=0;n<3000;n++)f.add('history-'+String(n).padStart(4,'0'),{kind:'inference-execute',state:'complete'});
  f.add('z-review');const claim=await f.jobs.claim({kinds:['review-execute']});
  assert.equal(claim.id,'z-review');assert.equal(claim.mode,'reconcile');assert.equal(claim.job.effectKey,'original-payment-z-review');assert.equal(claim.job.attempts,5);assert.deepEqual(claim.job.payload,{originalCase:'case-z-review'});
  assert.equal((await f.jobs.claim({kinds:['review-execute']})).idle,true);
 });
 test(name+': delayed and leased jobs wait; round robin reaches the other original review',async()=>{
  const f=fixture();f.add('a',{availableAt:now+1});f.add('b',{lease:{token:'other-worker',until:now+1}});f.add('c');f.add('d');
  assert.equal((await f.jobs.claim({kinds:['review-execute']})).id,'c');
  assert.equal((await f.jobs.claim({kinds:['review-execute']})).id,'d');
  assert.equal((await f.jobs.claim({kinds:['review-execute']})).idle,true);
  assert.equal((await f.tx.read('workflow-jobs','a')).revision,1);assert.equal((await f.tx.read('workflow-jobs','b')).revision,1);
 });
 test(name+': new quote keeps dispatch mode and never crosses review lanes',async()=>{
  const f=fixture();f.add('a');f.add('z',{kind:'review-quote',state:'queued',effect:'not_started'});
  const claim=await f.jobs.claim({kinds:['review-quote']});assert.equal(claim.id,'z');assert.equal(claim.mode,'dispatch');
  assert.equal((await f.tx.read('workflow-jobs','a')).revision,1);
 });
}
