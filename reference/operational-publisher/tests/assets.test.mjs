import test from 'node:test';
import assert from 'node:assert/strict';
import {managedAssets} from '../src/resources/assets.mjs';
const rid='res_'+'1'.repeat(24),oid='obj_'+'2'.repeat(24),sha='3'.repeat(64);
const fixed=Date.parse('2026-10-18T06:00:00Z');
function fixture(){
 const rows=new Map();const key=(k,id)=>k+':'+id;
 const store={
  async get(k,id){return structuredClone(rows.get(key(k,id))??null);},
  async put(k,id,v){const created=!rows.has(key(k,id));if(created)rows.set(key(k,id),structuredClone(v));return {created,value:await this.get(k,id)};},
  async change(k,id,rev,v){assert.equal(rows.get(key(k,id))?.revision,rev,'CAS conflict');rows.set(key(k,id),structuredClone(v));return structuredClone(v);},
  async list(k){return {items:[...rows.entries()].filter(([id])=>id.startsWith(k+':')).map(([,v])=>structuredClone(v)),nextOffset:null};},
  async begin(id,operation,input,prepared){const {value}=await this.put('action',id,{operation,input,prepared});return {row:{result:value}};},
  async complete(id,output){const current=await this.get('action',id);rows.set(key('action',id),{...current,output});return output;}
 };
 rows.set(key('resource',rid),{id:rid,provider:'r2',retentionDays:30});
 rows.set(key('object',oid),{id:oid,resourceId:rid,state:'ready',sha256:sha,bytes:400,verifiedAt:new Date(fixed-1000).toISOString(),expiresAt:new Date(fixed+86400000).toISOString()});
 const service=managedAssets({store,workStatus:async id=>id==='nw_real'?'working':null,now:()=>fixed});
 const input={name:'actual-dataset',expectedRevision:0,kind:'dataset',description:'A retained dataset',license:'Private owner data; no redistribution',source:'Owned object storage receipt',files:[{path:'data.json',resourceId:rid,objectId:oid,sha256:sha}],parents:[],workId:'nw_real'};
 return {rows,store,service,input};
}
test('asset versions retain verified original objects, lineage, diff and export after a later publication',async()=>{
 const {service,input}=fixture(),one=await service.call('asset_publish',input,'original');
 const next={...input,expectedRevision:1,description:'Updated interpretation',parents:[{name:input.name,version:one.asset.version}]};
 const two=await service.call('asset_publish',next,'next');assert.notEqual(one.asset.version,two.asset.version);
 assert.deepEqual(await service.call('asset_publish',input,'original'),one);
 const old=await service.call('asset_read',{name:input.name,version:one.asset.version});assert.equal(old.description,input.description);assert.equal(old.observation.available,true);
 const difference=await service.call('asset_diff',{name:input.name,fromVersion:one.asset.version,toVersion:two.asset.version});assert.deepEqual(difference.changed,[]);assert.deepEqual(difference.metadataChanged,['description']);
 const exported=await service.call('asset_export',{name:input.name,version:two.asset.version});assert.equal(exported.manifest.files[0].sha256,sha);assert.equal(exported.manifest.parents[0].version,one.asset.version);assert.equal(exported.manifest.visibility,'private');
});
test('unverified, expired, cross-resource objects, missing parents and path escapes cannot become versions',async()=>{
 for(const adjust of [x=>x.files[0].path='../secret',x=>x.files[0].sha256='4'.repeat(64),x=>x.files[0].resourceId='res_'+'5'.repeat(24),x=>x.parents.push({name:'unknown',version:sha}),x=>x.workId='nw_inactive']){
  const {service,input}=fixture();adjust(input);await assert.rejects(service.call('asset_publish',input,'invalid'),/^Error: resource_asset_/);
 }
 for(const changes of [{state:'uploading'},{expiresAt:new Date(fixed-1).toISOString()}]){
  const {rows,service,input}=fixture();Object.assign(rows.get('object:'+oid),changes);await assert.rejects(service.call('asset_publish',input,'invalid'),/verified_object_required/);
 }
});
test('retirement keeps history and interrupted publication reconciles by its original transition',async()=>{
 const {service,store,rows,input}=fixture(),one=await service.call('asset_publish',input,'original');
 const retire={name:input.name,expectedRevision:1,reason:'Superseded; retain original files until their declared expiry'};
 const result=await service.call('asset_retire',retire,'retire');assert.equal(result.filesRemoved,false);assert.equal((await service.call('asset_read',{name:input.name})).observation.available,false);
 const action=await store.get('action',result.id);delete action.output;rows.set('action:'+result.id,action);
 await service.call('asset_publish',{...input,expectedRevision:2,description:'Reactivated with explicit provenance'},'replacement');
 assert.equal((await service.call('asset_retire',retire,'retire')).asset.status,'retired');
 assert.equal((await service.call('asset_read',{name:input.name,version:one.asset.version})).files[0].objectId,oid);
 await assert.rejects(service.call('asset_publish',{...input,description:'Changed original request'},'original'),/request_conflict/);
});
