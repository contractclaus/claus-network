import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {managedQueues} from '../src/resources/queues.mjs';
import {managedEndpoints} from '../src/resources/endpoints.mjs';
import {digest} from '../src/resources/store.mjs';
function fixture(){
 const data=new Map();let at=1800000000000,work='working',dispatches=0,mode='success';const budgets=[];
 const store={async get(k,id){return structuredClone(data.get(k+':'+id)??null);},async put(k,id,v){const name=k+':'+id;if(!data.has(name))data.set(name,structuredClone(v));return {value:await this.get(k,id)};},async change(k,id,rev,v){const name=k+':'+id;if(data.get(name)?.revision!==rev)throw Error('resource_revision_conflict');data.set(name,structuredClone(v));return v;},async list(k,offset=0){const items=[...data].filter(([key])=>key.startsWith(k+':')).map(([,v])=>structuredClone(v));return {items:items.slice(offset,offset+50),nextOffset:items.length>offset+50?offset+50:null};},async jobs(q,states=[],offset=0,due=false){const items=[...data].filter(([key,v])=>key.startsWith('job:'+q+':')&&(!states.length||states.includes(v.state))&&(!due||Date.parse(v.nextAt)<=at)).map(([,v])=>structuredClone(v)).sort((a,b)=>Date.parse(a.nextAt)-Date.parse(b.nextAt));return {items:items.slice(offset,offset+50),nextOffset:items.length>offset+50?offset+50:null};},async begin(id,operation,input,prepared){await this.put('action',id,{operation,input,prepared,phase:'prepared'});return {row:{result:await this.get('action',id)}};},async dispatch(id){const v=data.get('action:'+id);if(v.phase!=='prepared')return false;v.phase='dispatched';return true;},async complete(id,output){data.get('action:'+id).output=output;return output;}};
 const seal=v=>'sealed:'+v,open=v=>v.slice(7),endpointId='res_'+'1'.repeat(24);
 const definition={url:'https://example.com/api',method:'POST',provider:'Example',documentation:'https://example.com/docs',dataRegion:'test fixture',exitPlan:'Disable endpoint',pricingEvidence:'Fixture only',maximumMicroUsd:'1000',timeoutSeconds:10,maximumResponseBytes:10000,inputSchema:{type:'object',properties:{task:{type:'string',maxLength:100}},required:['task'],additionalProperties:false},auth:null,idempotencyHeader:'idempotency-key',expiresAt:null,capabilities:['task']};
 data.set('resource:'+endpointId,{id:endpointId,provider:'http',status:'active',revision:1,definition});
 const endpoints=managedEndpoints({store,seal,open,now:()=>at,budget:async(...args)=>budgets.push(args),transport:async()=>{dispatches++;if(mode==='lost')throw Error('lost_after_provider_received_request');return {status:mode==='failed'?429:mode==='accepted'?202:200,text:'{"result":"done"}',type:'application/json'};}});
 const queues=managedQueues({store,endpoints,workStatus:async()=>work,open,now:()=>at});
 return {store,data,budgets,endpointId,queues,seal,get dispatches(){return dispatches;},set mode(v){mode=v;},set work(v){work=v;},advance(ms){at+=ms;},get at(){return at;},call:(op,input,id='fixture')=>queues.call(op,input,id,seal)};
}
async function create(f,name='fixture') {return (await f.call('queue_create',{name,purpose:'Actual fixture request',workId:'nw_fixture',endpointId:f.endpointId,endpointRevision:1,concurrency:2},name)).resource;}
test('a lost response survives a queue restart without a second paid dispatch, and late evidence reconciles after work cancellation',async()=>{
 const f=fixture(),q=await create(f),j=await f.call('queue_enqueue',{resourceId:q.id,arguments:{task:'produce result'}},'original');f.mode='lost';
 let result=await f.call('queue_run',{resourceId:q.id,jobId:j.id});assert.equal(result.state,'reconciling');f.advance(181000);
 result=await f.call('queue_run',{resourceId:q.id,jobId:j.id});assert.equal(f.dispatches,1);assert.equal(result.state,'reconciling');
 const id='act_'+digest(['owner',j.originalRequestId]).slice(0,24);await f.store.put('endpoint-response',id,{resourceId:f.endpointId,status:200,digest:'verified',at:new Date(f.at).toISOString()});f.work='cancelled';
 result=await f.call('queue_run',{resourceId:q.id,jobId:j.id});assert.equal(result.state,'succeeded');assert.equal(f.dispatches,1);assert(!f.budgets.some(x=>x[0]==='cancel'));
});
test('terminal failure has a dead-letter state, dependencies stop, and asynchronous acceptance is not success',async()=>{
 const f=fixture(),q=await create(f),a=await f.call('queue_enqueue',{resourceId:q.id,arguments:{task:'first'}},'first');
 const b=await f.call('queue_enqueue',{resourceId:q.id,arguments:{task:'dependent'},dependsOn:[a.id]},'dependent');f.mode='failed';
 assert.equal((await f.call('queue_run',{resourceId:q.id,jobId:a.id})).state,'failed');assert.equal((await f.call('queue_run',{resourceId:q.id,jobId:b.id})).state,'blocked');assert.equal(f.dispatches,1);
 const c=await f.call('queue_enqueue',{resourceId:q.id,arguments:{task:'asynchronous'}},'third');f.mode='accepted';assert.equal((await f.call('queue_run',{resourceId:q.id,jobId:c.id})).state,'accepted');
 assert.equal((await f.call('queue_jobs',{resourceId:q.id,states:['failed','blocked']})).items.length,2);
});
test('authenticated webhook binds raw body, freshness and original event identity to one queue',async()=>{
 const f=fixture(),q=await create(f),secretId='sec_'+'2'.repeat(24),value='fixture-application-secret';await f.store.put('secret',secretId,{id:secretId,kind:'application',status:'active',version:1,sealed:f.seal(value)});
 await f.call('queue_webhook',{resourceId:q.id,expectedRevision:1,secretId,version:1,enabled:true});const raw='{"task":"incoming event"}',timestamp=String(f.at/1000),eventId='provider-event-42',signature=createHmac('sha256',value).update(timestamp+'.'+eventId+'.'+raw).digest('hex');
 const first=await f.queues.webhook(q.id,{timestamp,eventId,signature,raw},f.seal),again=await f.queues.webhook(q.id,{timestamp,eventId,signature,raw},f.seal);assert.equal(first.id,again.id);assert.equal((await f.call('queue_jobs',{resourceId:q.id})).items.length,1);
 await assert.rejects(f.queues.webhook(q.id,{timestamp,eventId,signature,raw:'{"task":"changed"}'},f.seal),/webhook_invalid/);f.advance(301000);await assert.rejects(f.queues.webhook(q.id,{timestamp,eventId,signature,raw},f.seal),/webhook_invalid/);assert.equal(f.dispatches,0);
});
