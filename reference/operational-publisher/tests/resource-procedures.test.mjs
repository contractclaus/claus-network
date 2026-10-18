import test from 'node:test';
import assert from 'node:assert/strict';
import {managedProcedures} from '../src/resources/procedures.mjs';
test('procedure use retains its exact version and accepts only later real result evidence',async()=>{
 const records=new Map();let at=1800000000000;
 const store={async get(k,id){return records.get(k+':'+id)??null;},async put(k,id,v){const key=k+':'+id;if(!records.has(key))records.set(key,v);return {value:records.get(key)};},async change(k,id,rev,v){if(records.get(k+':'+id)?.revision!==rev)throw Error('resource_revision_conflict');records.set(k+':'+id,v);},async list(k){return {items:[...records].filter(([key])=>key.startsWith(k+':')).map(([,v])=>v),nextOffset:null};}};
 const p=managedProcedures({store,workStatus:async()=> 'working',now:()=>at}),ref={kind:'endpoint',actionId:'act_'+'1'.repeat(24)};
 const definition={name:'recover-original-request',expectedRevision:0,summary:'Recover by original identity',terms:['lost','request'],steps:['Read the original request receipt.','Use the same action identity.'],limitations:'Only a known original request; unknown results remain unknown.',sources:[ref],status:'active'};
 await assert.rejects(p.call('procedure_save',definition,'save'),/source_unavailable/);
 await store.put('endpoint-response',ref.actionId,{digest:'retained-response',at:new Date(at-1000).toISOString(),status:200});
 const v=await p.call('procedure_save',definition,'save'),use=await p.call('procedure_use',{name:v.name,revision:1,workId:'nw_actual'},'apply');
 assert.equal(use.bodyHash,v.bodyHash);assert.equal(use.grantsPermissions,false);
 await assert.rejects(p.call('procedure_result',{useId:use.id,sources:[ref],assessment:'Old result does not prove this use.'},'result'),/fresh_matching_evidence/);
 at+=1000;const next={kind:'endpoint',actionId:'act_'+'2'.repeat(24)};await store.put('endpoint-response',next.actionId,{digest:'new-response',at:new Date(at).toISOString(),status:200});
 const outcome=await p.call('procedure_result',{useId:use.id,sources:[next],assessment:'Original identity returned the current response.'},'result');assert.equal(outcome.revision,1);
 await p.call('procedure_save',{...definition,expectedRevision:1,steps:[...definition.steps,'Keep the original reservation.']},'new-version');
 assert.equal((await p.call('procedure_read',{name:v.name,revision:1})).bodyHash,v.bodyHash);await assert.rejects(p.call('procedure_use',{name:v.name,revision:1,workId:'nw_actual'},'stale'),/not_applicable/);
});
