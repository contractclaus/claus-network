import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {runtimeTuning,tuningPatch} from '../src/resources/runtime-tuning.mjs';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function fixture(){
 const rows=new Map(),history=[],content={identity:'retained identity',policy:{capabilities:{networkBuild:true},rules:[{id:'budget',enabled:true,text:'retained budget'}]},settings:{enabled:true,role:'operator',model:'gpt-model',provider:'openai',networkOperations:{enabled:true},maxActionsPerTurn:12,maxOutputTokens:8192,reasoningEffort:'high'}};
 history.push({revision:10,hash:hash(content),content});let writes=0,loseReply=false,work='working';
 const configuration={hash,read:async id=>structuredClone(id===undefined?history.at(-1):history.find(r=>r.revision===id)),childOf:async id=>structuredClone(history.find(r=>r.parent===id)),update:async({configuration:c,expectedRevision},origin)=>{assert.equal(origin,'claus-runtime');if(history.at(-1).revision!==expectedRevision)throw Error('configuration_conflict');writes++;history.push({revision:history.at(-1).revision+1,parent:expectedRevision,hash:hash(c),content:c});if(loseReply)throw Error('reply lost');}};
 const store={get:async(_k,id)=>rows.get(id),begin:async(id,operation,input,prepared)=>{if(!rows.has(id))rows.set(id,{operation,input,prepared});return {row:{result:rows.get(id)}};},complete:async(id,result)=>{rows.get(id).output=result;return result;}};
 return {service:runtimeTuning({store,configuration,workStatus:async()=>work}),history,content,rows,writes:()=>writes,lose:()=>{loseReply=true;},stop:()=>{work='completed';}};
}
test('runtime tuning changes only delegated technical fields and recovers a lost commit reply',async()=>{
 const f=fixture();f.lose();const input={expectedRevision:10,workId:'nw_real',patch:{reasoningEffort:'medium',maxActionsPerTurn:16},reason:'Tune chunk duration for this existing work'};
 const result=await f.service.call('runtime_tune',input,'original');assert.equal(result.revision,11);assert.equal(result.actor,'claus-runtime');assert.equal(f.writes(),1);assert.deepEqual(f.history.at(-1).content.policy,f.content.policy);assert.equal(f.history.at(-1).content.identity,f.content.identity);
 f.stop();assert.deepEqual(await f.service.call('runtime_tune',input,'original'),result);assert.equal(f.writes(),1);
 assert.throws(()=>tuningPatch({enabled:true}),/patch_invalid/);assert.throws(()=>tuningPatch({policy:{}}),/patch_invalid/);
});
test('owner revision changes and inactive work block new tuning without writes',async()=>{
 const f=fixture(),input={expectedRevision:10,workId:'nw_real',patch:{maxOutputTokens:4096},reason:'Reduce response size'};f.stop();await assert.rejects(f.service.call('runtime_tune',input,'stopped'),/inactive/);assert.equal(f.writes(),0);
 const g=fixture();g.history.push({...g.history[0],revision:12,parent:10,hash:'owner-change'});await assert.rejects(g.service.call('runtime_tune',input,'stale'),/revision_conflict/);assert.equal(g.writes(),0);
});
