import test from 'node:test';
import assert from 'node:assert/strict';
import {managedServices} from '../src/resources/services.mjs';
const rid='res_'+'a'.repeat(24),repo='res_'+'b'.repeat(24),sid='sec_'+'c'.repeat(24),commit='d'.repeat(40);
function fixture(){
 const rows=new Map(),clone=x=>structuredClone(x);
 const store={get:async(k,id)=>clone(rows.get(k+':'+id)??null),put:async(k,id,v)=>{const key=k+':'+id,created=!rows.has(key);if(created)rows.set(key,clone(v));return {created,value:clone(rows.get(key))};},change:async(k,id,rev,v)=>{const key=k+':'+id;if(rows.get(key)?.revision!==rev)throw Error('resource_revision_conflict');rows.set(key,clone(v));return clone(v);},list:async()=>({items:[],nextOffset:null})};
 rows.set('resource:'+rid,{id:rid,provider:'vercel',providerId:'project',name:'managed'});rows.set('resource:'+repo,{id:repo,provider:'github'});
 const state={work:'working',settings:{buildCommand:'old'},deployment:'dpl_old',calls:[],secretValue:'PRIVATE_VALUE_NEVER_RETURN',env:[],unknown:false};
 rows.set('secret:'+sid,{id:sid,version:1,kind:'application',status:'active',sealed:state.secretValue});
 const providers={readSettings:async(_r,keys)=>Object.fromEntries(keys.map(k=>[k,state.settings[k]??null])),read:async()=>({deployment:state.deployment}),envs:async()=>state.env,envValue:async()=>state.secretValue,deployments:async()=>[{id:'dpl_new',state:'READY'}]};
 const invoke=async(op,input,id)=>{state.calls.push({op,input,id});if(state.unknown){state.unknown=false;return {state:'outcome_unknown'};}if(op==='settings'){Object.assign(state.settings,input.settings);return {settings:input.settings};}if(op==='bind_secret'){state.env=[{id:'env',key:input.envName,target:['production']}];rows.set('binding:'+rid+':'+input.envName,{...input,status:'bound'});return {bound:true};}if(op==='deployment_stage')return {deployment:{id:'dpl_new',state:'BUILDING'}};if(op==='deployment_promote'){state.deployment='dpl_new';rows.set('publication:dpl_new',{sourceCommit:commit,repositoryId:repo});return {promoted:true};}throw Error('unexpected '+op);};
 const service=managedServices({store,providers,open:v=>v,workStatus:async()=>state.work,invoke});
 const input={name:'application',expectedRevision:0,purpose:'Existing application configuration',workId:'nw_real',enabled:true,targets:[{resourceId:rid,dependsOn:[],settings:{buildCommand:'new'},deployment:{repositoryId:repo,commit,healthPath:'/health'}}]};
 return {rows,store,state,service,input};
}
test('a versioned service retains settings and the original staged deployment through promotion',async()=>{
 const f=fixture();await f.service.call('service_define',f.input,'define');const p=await f.service.call('service_plan',{name:'application',revision:1});assert.equal(p.steps.length,2);
 assert.equal((await f.service.call('service_apply',{planId:p.id})).cursor,1);
 assert.equal((await f.service.call('service_apply',{planId:p.id})).deploymentId,'dpl_new');
 const done=await f.service.call('service_apply',{planId:p.id});assert.equal(done.state,'completed');assert.equal(f.state.calls.filter(c=>c.op==='deployment_stage').length,1);
 assert.equal((await f.service.call('service_apply',{planId:p.id})).state,'completed');assert.equal(f.state.calls.length,3);
 assert.equal((await f.service.call('service_plan',{name:'application',revision:1})).steps.length,0);
 await f.service.call('service_define',{...f.input,expectedRevision:1,enabled:false},'disable');assert.equal((await f.service.call('service_read',{name:'application',revision:1})).enabled,true);
 await assert.rejects(f.service.call('service_apply',{planId:p.id}),/inactive/);
});
test('provider drift and stale definitions cannot overwrite an intervening change',async()=>{
 const f=fixture();await f.service.call('service_define',f.input,'define');const p=await f.service.call('service_plan',{name:'application',revision:1});f.state.settings.buildCommand='manual';
 await assert.rejects(f.service.call('service_apply',{planId:p.id}),/observation_changed/);assert.equal(f.state.calls.length,0);
 await assert.rejects(f.service.call('service_define',{...f.input,purpose:'different'},'other'),/revision_conflict/);
 f.state.work='completed';await assert.rejects(f.service.call('service_plan',{name:'application',revision:1}),/inactive/);
});
test('an uncertain operation resumes its exact ID and active service lease excludes another plan',async()=>{
 const f=fixture();await f.service.call('service_define',f.input,'define');const p=await f.service.call('service_plan',{name:'application',revision:1});f.state.unknown=true;
 assert.equal((await f.service.call('service_apply',{planId:p.id})).state,'pending');await f.service.call('service_apply',{planId:p.id});assert.equal(f.state.calls[0].id,f.state.calls[1].id);assert.deepEqual(f.state.calls[0].input,f.state.calls[1].input);
 f.rows.set('service-lease:application',{revision:99,until:Date.now()+100000,token:'other'});assert.equal((await f.service.call('service_apply',{planId:p.id})).state,'busy');
});
test('binding plans expose references only, reject public variables and fail on revocation',async()=>{
 const f=fixture(),binding={envName:'MODEL_KEY',secretId:sid,version:1};f.input.targets[0].bindings=[binding];await f.service.call('service_define',f.input,'define');const p=await f.service.call('service_plan',{name:'application',revision:1});assert.equal(JSON.stringify(p).includes(f.state.secretValue),false);
 await f.service.call('service_apply',{planId:p.id});await f.service.call('service_apply',{planId:p.id});assert.equal(f.state.calls[1].op,'bind_secret');assert.equal(JSON.stringify(await f.service.call('service_status',{name:'application'})).includes(f.state.secretValue),false);
 const secret=f.rows.get('secret:'+sid);secret.status='revoked';await assert.rejects(f.service.call('service_apply',{planId:p.id}),/secret_inactive/);
 const g=fixture();g.input.targets[0].bindings=[{...binding,envName:'NEXT_PUBLIC_KEY'}];await assert.rejects(g.service.call('service_define',g.input,'bad'),/binding_invalid/);
});
