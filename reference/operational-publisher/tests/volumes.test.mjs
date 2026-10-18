import test from 'node:test';
import assert from 'node:assert/strict';
import {managedVolumes} from '../src/resources/volumes.mjs';
import {runtimeVolumes,volumeReference} from '../src/infrastructure/runtime-volumes.mjs';
const day=86400000;
function fixture(){
 let time=Date.parse('2026-10-18T12:00:00Z'),active=true,created=0,patched=0,removed=0,createHook=null,resizeHook=null,attachHook=()=>({items:[],nextCursor:null});
 const rows=new Map(),external=new Map(),fundingCalls=[],budgetCalls=[];const key=(kind,id)=>kind+':'+id;
 const store={
  async get(k,id){return structuredClone(rows.get(key(k,id))??null);},
  async put(k,id,v){const created=!rows.has(key(k,id));if(created)rows.set(key(k,id),structuredClone(v));return {created,value:await this.get(k,id)};},
  async change(k,id,rev,v){assert.equal(rows.get(key(k,id))?.revision,rev,'CAS conflict');rows.set(key(k,id),structuredClone(v));return structuredClone(v);},
  async list(k){return {items:[...rows.entries()].filter(([id])=>id.startsWith(k+':')).map(([,v])=>structuredClone(v)),nextOffset:null};},
  async begin(id,operation,input,prepared){const {value}=await this.put('action',id,{operation,input,prepared,phase:'prepared'});return {row:{result:value}};},
  async dispatch(id){const r=rows.get(key('action',id));if(r.phase!=='prepared'&&!(r.phase==='provider_retry'&&Date.parse(r.retryAt)<=time))return false;r.phase='dispatched';return true;},
  async deferRejected(id,retryAt){const r=rows.get(key('action',id));assert.equal(r.phase,'dispatched');Object.assign(r,{phase:'provider_retry',retryAt});},
  async complete(id,output){Object.assign(rows.get(key('action',id)),{output:structuredClone(output)});return output;}
 };
 const provider={
  async catalog(){return {regions:[{id:'EU-RO-1'}]};},
  async pricing(){return {maximumMicroUsdPerGbMonth:'70000',source:'official-price',observedAt:new Date(time).toISOString()};},
  async create(v){created++;if(createHook)return createHook(v);const r={id:'vol1',name:v.name,size:v.sizeGb,dataCenter:v.region,type:'STANDARD'};external.set(r.id,r);return structuredClone(r);},
  async read(id){return structuredClone(external.get(id)??null);},
  async find(name){return {items:[...external.values()].filter(v=>v.name===name),nextCursor:null};},
  async resize(id,size){patched++;if(resizeHook)return resizeHook(id,size);external.get(id).size=size;return this.read(id);},
  async attachments(id,cursor){return attachHook(id,cursor);},
  async remove(id){removed++;external.delete(id);return {removed:true};},
  async cost(){return {final:false};}
 };
 const workStatus=async()=>active?'working':'completed';
 const service=managedVolumes({store,provider,workStatus,budget:async(...a)=>budgetCalls.push(a),funding:async(...a)=>fundingCalls.push(a),now:()=>time});
 const input={name:'model-checkpoints',purpose:'Retain checkpoints for an active training task',projectId:'prj_model',workId:'nw_training',region:'EU-RO-1',sizeGb:100,fundedDays:2,autoRenew:true};
 return {service,store,rows,provider,input,external,fundingCalls,budgetCalls,workStatus,now:()=>time,advance:ms=>time+=ms,end:()=>active=false,onCreate:f=>createHook=f,onResize:f=>resizeHook=f,onAttachments:f=>attachHook=f,counts:()=>({created,patched,removed})};
}
test('unknown volume creation reconciles the original identity without a second create',async()=>{
 const f=fixture();f.onCreate(v=>{f.external.set('vol1',{id:'vol1',name:v.name,size:v.sizeGb,dataCenter:v.region,type:'STANDARD'});throw Error('network lost after acceptance');});
 await assert.rejects(f.service.call('volume_create',f.input,'original'),/network lost/);
 const result=await f.service.call('volume_create',f.input,'original');assert.equal(result.resource.providerId,'vol1');assert.equal(f.counts().created,1);
 assert.deepEqual(await f.service.call('volume_create',f.input,'original'),result);
 assert.equal(f.fundingCalls.filter(x=>x[0]==='accept').length,1);
 assert.equal(f.fundingCalls[0][2].maximum,result.maximumCostMicroUsd);
 await assert.rejects(f.service.call('volume_create',{...f.input,sizeGb:200},'original'),/request_conflict/);
});
test('definitive rate limit retains original retry time and reservation, then retries once',async()=>{
 const f=fixture();f.onCreate(()=>{const e=Error('rate limit');e.status=429;e.retryAt=f.now()+300000;throw e;});
 const limited=await f.service.call('volume_create',f.input,'original');assert.equal(limited.state,'provider_rate_limited');
 await f.service.call('volume_create',f.input,'original');assert.equal(f.counts().created,1);assert.equal(f.fundingCalls.some(x=>x[0]==='cancel'),false);
 f.advance(300001);f.onCreate(null);assert.equal((await f.service.call('volume_create',f.input,'original')).resource.status,'active');assert.equal(f.counts().created,2);
});
test('resize reconciles an accepted provider update and original renewal history survives later edits',async()=>{
 const f=fixture(),one=await f.service.call('volume_create',f.input,'create');
 const renewInput={resourceId:one.resource.id,expectedRevision:1,fundedDays:1};
 const renewed=await f.service.call('volume_renew',renewInput,'renew');
 delete f.rows.get('action:'+renewed.id).output;
 f.onResize((id,size)=>{f.external.get(id).size=size;throw Error('response lost');});
 const resizeInput={resourceId:one.resource.id,expectedRevision:renewed.resource.revision,sizeGb:200};
 await assert.rejects(f.service.call('volume_resize',resizeInput,'resize'),/response lost/);
 const resized=await f.service.call('volume_resize',resizeInput,'resize');assert.equal(resized.resource.sizeGb,200);assert.equal(f.counts().patched,1);
 assert.equal((await f.service.call('volume_renew',renewInput,'renew')).resource.sizeGb,100);
});
test('deletion requires data disposition and complete detached inventory before removing volume',async()=>{
 const f=fixture(),one=await f.service.call('volume_create',f.input,'create'),resourceId=one.resource.id;
 await assert.rejects(f.service.call('volume_delete',{resourceId,expectedRevision:1,disposition:{kind:'backed-up',name:'missing',version:'a'.repeat(64)}},'invalid'),/backup_manifest_unavailable/);
 let attached=true;f.onAttachments((id,cursor)=>cursor===null?{items:[],nextCursor:'page2'}:{items:attached?[{id:'pod',status:'RUNNING'}]:[],nextCursor:null});
 const input={resourceId,expectedRevision:1,disposition:{kind:'discard',reason:'Owner intentionally discarded intermediate checkpoints'}};
 assert.equal((await f.service.call('volume_delete',input,'delete')).state,'checking_attachments');
 assert.equal((await f.service.call('volume_delete',input,'delete')).state,'waiting_for_detach');assert.equal(f.counts().removed,0);
 const binding=runtimeVolumes({store:f.store,provider:f.provider,workStatus:f.workStatus,now:f.now});
 assert.equal(await binding.active({projectId:'prj_model',manifest:{region:'EU-RO-1',storageGiB:100,networkVolume:{resourceId,path:'/workspace'}}}),false);
 attached=false;await f.service.call('volume_delete',input,'delete');assert.equal((await f.service.call('volume_delete',input,'delete')).providerStorageStopped,true);assert.equal(f.counts().removed,1);
});
test('runtime binding requires matching project, region, provider identity and funded active work',async()=>{
 const f=fixture(),one=await f.service.call('volume_create',f.input,'create');
 const binding=runtimeVolumes({store:f.store,provider:f.provider,workStatus:f.workStatus,now:f.now});
 const work={projectId:'prj_model',leaseSeconds:3600,manifest:{region:'EU-RO-1',storageGiB:100,networkVolume:{resourceId:one.resource.id,path:'/workspace'}}};
 assert.deepEqual(await binding.load(work),{volumeId:'vol1',path:'/workspace'});
 await assert.rejects(binding.load({...work,projectId:'prj_other'}),/binding_mismatch/);
 await assert.rejects(binding.load({...work,leaseSeconds:3*86400}),/renew_storage_before/);
 await assert.rejects(binding.matches({mounts:{network:[{volumeId:'other',path:'/workspace'}]}},work),/pod_binding_changed/);
 assert.throws(()=>volumeReference({...work,manifest:{...work.manifest,networkVolume:{...work.manifest.networkVolume,path:'/workspace/../etc'}}}),/reference_invalid/);
 f.end();assert.equal(await binding.active(work),false);await assert.rejects(binding.load(work),/inactive/);
});
test('automatic renewal requires active work; ended work retains data and reports continuing storage charges',async()=>{
 const f=fixture(),one=await f.service.call('volume_create',f.input,'create');f.advance(2*day-3600000);await f.service.tick();
 let r=await f.store.get('resource',one.resource.id);assert(Date.parse(r.fundedUntil)>f.now()+day);
 f.end();f.advance(2*day);await f.service.tick();r=await f.store.get('resource',one.resource.id);
 assert.equal(r.maintenance.state,'retention_needs_action');assert.equal(f.counts().removed,0);
});

import {volumeProvider} from '../src/resources/volume-provider.mjs';
test('high-performance originals retain their tier through uncertain creation, binding and renewal',async()=>{
 const f=fixture(),seen=[];
 f.provider.pricing=async(type)=>{seen.push(type);return {maximumMicroUsdPerGbMonth:type==='HIGH_PERFORMANCE'?'140000':'70000'};};
 f.onCreate(v=>{f.external.set('vol1',{id:'vol1',name:v.name,size:v.sizeGb,dataCenter:v.region,type:v.volumeType});throw Error('accepted without receipt');});
 const input={...f.input,volumeType:'HIGH_PERFORMANCE'};
 await assert.rejects(f.service.call('volume_create',input,'original-hp'),/accepted without receipt/);
 const one=await f.service.call('volume_create',input,'original-hp');assert.equal(one.resource.volumeType,'HIGH_PERFORMANCE');assert.equal(f.counts().created,1);
 const binding=runtimeVolumes({store:f.store,provider:f.provider,workStatus:f.workStatus,now:f.now});
 const work={projectId:'prj_model',leaseSeconds:3600,manifest:{region:input.region,storageGiB:100,networkVolume:{resourceId:one.resource.id,path:'/workspace'}}};
 assert.equal((await binding.load(work)).volumeId,'vol1');
 await f.service.call('volume_renew',{resourceId:one.resource.id,expectedRevision:1,fundedDays:1},'renew-hp');
 assert(seen.every(x=>x==='HIGH_PERFORMANCE'));
 f.external.get('vol1').type='STANDARD';await assert.rejects(binding.load(work),/provider_changed/);
});
test('high-performance quotes require current evidence for the requested region',async()=>{
 const old=process.env.RUNPOD_HIGH_PERFORMANCE_PRICE_JSON,time=Date.parse('2026-10-18T12:00:00Z');
 const p=volumeProvider({now:()=>time});
 try{
  process.env.RUNPOD_HIGH_PERFORMANCE_PRICE_JSON=JSON.stringify({type:'HIGH_PERFORMANCE',maximumMicroUsdPerGbMonth:'140000',regions:['US-CA-2'],observedAt:new Date(time-1000).toISOString(),validUntil:new Date(time+86400000).toISOString()});
  assert.equal((await p.pricing('HIGH_PERFORMANCE','US-CA-2')).maximumMicroUsdPerGbMonth,'140000');
  await assert.rejects(p.pricing('HIGH_PERFORMANCE','EU-CZ-1'),/price_unavailable/);
  const expired=JSON.parse(process.env.RUNPOD_HIGH_PERFORMANCE_PRICE_JSON);expired.validUntil=new Date(time-1).toISOString();process.env.RUNPOD_HIGH_PERFORMANCE_PRICE_JSON=JSON.stringify(expired);
  await assert.rejects(p.pricing('HIGH_PERFORMANCE','US-CA-2'),/price_unavailable/);
 }finally{if(old===undefined)delete process.env.RUNPOD_HIGH_PERFORMANCE_PRICE_JSON;else process.env.RUNPOD_HIGH_PERFORMANCE_PRICE_JSON=old;}
});
