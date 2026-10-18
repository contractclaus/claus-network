import test from 'node:test';import assert from 'node:assert/strict';
import {createResourceService} from '../src/resources/service.mjs';
import {sealSecret,openSecret} from '../src/resources/vault.mjs';
import {retryTime} from '../src/resources/providers.mjs';
function fixture(){
 const rows=new Map(),key=(k,id)=>k+':'+id,master=Buffer.alloc(32,7),providerObjects=new Map(),envs=new Map();let creates=0,writes=0,status='working',lost=false;
 const store={
  async get(k,id){return structuredClone(rows.get(key(k,id))??null);},
  async list(k,offset=0){return {items:[...rows.entries()].filter(([id])=>id.startsWith(k+':')).slice(offset,offset+50).map(([,v])=>structuredClone(v)),nextOffset:null};},
  async put(k,id,v){const exists=rows.has(key(k,id));if(!exists)rows.set(key(k,id),structuredClone(v));return {created:!exists,value:await this.get(k,id)};},
  async change(k,id,revision,v){assert.equal(rows.get(key(k,id)).revision,revision);rows.set(key(k,id),structuredClone(v));return v;},
  async begin(id,operation,input,prepared){const created=!rows.has(key('action',id));if(created)rows.set(key('action',id),{operation,input,prepared,phase:'prepared'});return {created,row:{result:await this.get('action',id)}};},
  async dispatch(id){const v=rows.get(key('action',id));if(v.phase!=='prepared')return false;v.phase='dispatched';return true;},
  async complete(id,result){rows.get(key('action',id)).output=result;return result;}
 };
 const providers={configured:()=>({vault:true}),async find(p,n){return providerObjects.get(n)??null;},async create(provider,name){creates++;const r={provider,name,providerId:'p1',owner:'claus'};providerObjects.set(name,r);if(lost)throw Error('lost_provider_response');return r;},async read(r){return r;},async envs(){return [...envs].map(([key,v])=>({key,id:v.id,target:['production']}));},async envValue(r,id){return [...envs.values()].find(v=>v.id===id)?.value;},async setEnv(r,key,value){writes++;envs.set(key,{id:'env_'+key,value});}};
 const service=createResourceService({store,providers,seal:(v,a)=>sealSecret(v,a,master),open:(v,a)=>openSecret(v,a,master),workStatus:async()=>status,environment:{}});
 return {service,store,envs,master,get creates(){return creates;},get writes(){return writes;},lost:()=>{lost=true;},finish:()=>{status='completed';}};
}
test('uncertain project creation reconciles the original project without another write',async()=>{
 const f=fixture();f.lost();const input={name:'real-project',purpose:'Host an existing application'};
 await assert.rejects(f.service.call('project_create',input,'project-request'),/lost_provider_response/);
 const recovered=await f.service.call('project_create',input,'project-request');assert(recovered.resource.id);assert.equal(f.creates,1);
 assert.deepEqual(await f.service.call('project_create',input,'project-request'),recovered);assert.equal(f.creates,1);
 await assert.rejects(f.service.call('secret_create',{name:'test-key',value:'must-not-be-stored'},'bad'),/input_invalid/);
});
test('application secrets rotate through encrypted bindings and worker grants stop with their work',async()=>{
 const f=fixture();const created=await f.service.call('project_create',{name:'real-project',purpose:'Existing application'},'p'),resourceId=created.resource.id;
 const createdSecret=await f.service.call('secret_create',{name:'application-key'},'s'),secretId=createdSecret.secret.id;
 const saved=await f.store.get('secret',secretId),plaintext=openSecret(saved.sealed,secretId+':1',f.master);
 assert(!JSON.stringify(createdSecret).includes(plaintext));assert(!JSON.stringify(createdSecret).includes('ciphertext'));
 assert.throws(()=>openSecret(saved.sealed,'another-secret:1',f.master));
 const bind={resourceId,secretId,version:1,envName:'APP_API_KEY'};
 assert.equal((await f.service.call('bind_secret',bind,'b')).bound,true);assert.equal(f.envs.get('APP_API_KEY').value,plaintext);
 await f.service.call('bind_secret',bind,'b');assert.equal(f.writes,1);
 const rotated=await f.service.call('secret_rotate',{secretId,expectedRevision:1},'rotate');assert.equal(rotated.secret.version,2);
 await f.service.call('bind_secret',{...bind,version:2},'b2');assert.notEqual(f.envs.get('APP_API_KEY').value,plaintext);
 const grant=await f.service.call('grant_create',{name:'worker-access',workId:'nw_existing',resourceIds:[resourceId],operations:['resource'],expiresAt:'2099-01-01T00:00:00Z'},'g');
 const row=await f.store.get('secret',grant.secret.id),token=openSecret(row.sealed,row.id+':1',f.master);
 assert.equal((await f.service.call('resource',{resourceId},'read',{grant:token})).id,resourceId);
 await assert.rejects(f.service.call('resource',{resourceId:'website'},'read',{grant:token}),/scope_denied/);
 f.finish();await assert.rejects(f.service.call('resource',{resourceId},'read',{grant:token}),/work_inactive/);
 await f.service.call('secret_revoke',{secretId:row.id,expectedRevision:1},'revoke');await assert.rejects(f.service.authorization(token,'resource',{resourceId}),/inactive/);
});
test('provider retry-after supports seconds and HTTP-date without converting five minutes into tomorrow',()=>{
 const now=Date.parse('2026-10-18T04:00:00Z');assert.equal(retryTime('300',now),now+300000);assert.equal(retryTime('Sun, 18 Oct 2026 04:05:00 GMT',now),now+300000);
});
