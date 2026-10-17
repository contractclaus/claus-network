import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {semanticNetworkSearch,semanticSearchEndpoint,semanticSearchRelease as s} from '../reference/native-operations/src/network-semantic-search.js';
import {createNetworkAccess} from '../reference/native-operations/src/network-access.js';

const now=()=>1800000000000;
const approval=()=>({approved:true,releaseId:s.releaseId,projectId:s.projectId,image:s.image});
const resources=()=>({nextCursor:null,items:[{projectId:s.projectId,profileId:'claus-runpod-cpu-v1',state:'running',desired:'running',terminal:false,
 manifest:{releaseHash:s.releaseId,image:s.image,port:8080,mode:'model'},leaseUntil:now()+60000,providerLeaseUntil:now()+60000,
 providerResourceId:'abc123xyz',endpoint:'https://abc123xyz-8080.proxy.runpod.net'}]});
const project=(i:number)=>({id:'prj_'+i,slug:'project-'+i,name:'Project '+i,description:'Public service '+i,agents:[],services:[],application:null,detailStatus:'available',listings:{}});
const inventory=(count=20)=>({schemaVersion:'claus-observation/1',observedAt:now(),projects:Array.from({length:count},(_,i)=>project(i)),counts:{},detailsComplete:true,graphComplete:true,nextCursor:null});
function deps(value=inventory()){
 const calls:any[]=[],posts:any[]=[];
 return {calls,posts,now,call:async(name:string,input:any)=>{calls.push({name,input});if(name==='public_resource_release')return approval();if(name==='resource_instances')return resources();if(name==='network_overview')return value;throw Error('unexpected_operation');},
  post:async(endpoint:string,body:any,signal:AbortSignal)=>{posts.push({endpoint,body,signal});return {model:s.model,results:body.documents.map((d:any)=>({id:d.id,score:Number(d.id.slice(4))/100})).sort((a:any,b:any)=>b.score-a.score).slice(0,body.limit)};}};
}

test('ranks all catalogue batches together and sends only public fields to the pinned model',async()=>{
 const value=inventory();Object.assign(value.projects[0],{privateMemory:'secret',accessToken:'secret'});const d=deps(value);
 const r=await semanticNetworkSearch({query:'  public services  ',limit:3},d);
 assert.deepEqual(r.results.map(x=>x.projectId),['prj_19','prj_18','prj_17']);assert.equal(r.coverage.complete,true);
 assert.equal(d.posts.length,2);assert(d.posts.every(p=>p.body.documents.length<=15&&p.endpoint==='https://abc123xyz-8080.proxy.runpod.net'));
 assert(!JSON.stringify(d.posts).includes('secret'));assert.equal(r.results[0].url,'https://claus.si/c/project-19');
 assert.equal(d.posts[0].body.query,'public services');
});

test('revoked releases, expired provider leases, ambiguous resources and substituted endpoints fail closed',()=>{
 assert.throws(()=>semanticSearchEndpoint({...approval(),approved:false},resources(),now()),/not_approved/);
 for(const change of [{providerLeaseUntil:now()},{endpoint:'https://attacker.example'},{providerResourceId:'127.0.0.1'},{manifest:{...resources().items[0].manifest,image:'other'}},{state:'starting'}]){
  const r=resources();Object.assign(r.items[0],change);assert.throws(()=>semanticSearchEndpoint(approval(),r,now()));
 }
 const duplicate=resources();duplicate.items.push({...duplicate.items[0]});assert.throws(()=>semanticSearchEndpoint(approval(),duplicate,now()));
 assert.throws(()=>semanticSearchEndpoint(approval(),{...resources(),nextCursor:'more'},now()),/incomplete/);
});

test('incomplete catalogue coverage remains explicit and unknown model output is not a successful search',async()=>{
 const value:any=inventory(2);value.nextCursor='project-1';value.projects[0].name='Project 00';value.projects[0].description='😀'.repeat(1500);const d=deps(value);
 const r=await semanticNetworkSearch({query:'search',after:'project-0'},d);
 assert.equal(r.coverage.complete,false);assert.equal(r.coverage.nextCursor,'project-1');assert.equal(r.coverage.descriptionsTruncated,1);
 assert(d.posts[0].body.documents[0].text.length<=2048);assert(d.posts[0].body.documents[0].text.isWellFormed());
 assert.deepEqual(d.calls.find(c=>c.name==='network_overview').input,{after:'project-0'});
 for(const bad of [{model:'other',results:[]},{model:s.model,results:[{id:'prj_foreign',score:0.2}]},{model:s.model,results:[{id:'prj_0',score:Infinity},{id:'prj_1',score:0}]},{model:s.model,results:[{id:'prj_0',score:0},{id:'prj_0',score:0}]}]){
  await assert.rejects(semanticNetworkSearch({query:'search'},{...deps(inventory(2)),post:async()=>bad}),/response_invalid/);
 }
});

test('the read tool describes and validates the operation without providing a write or private document input',async()=>{
 const access=createNetworkAccess({request:async()=>{throw Error('must not fetch');}});
 const described:any=await access.tool('read_network',{operation:'network_semantic_search',describe:true});
 assert.equal(described.inputSchema.additionalProperties,false);assert.deepEqual(described.inputSchema.required,['query']);
 const bad=await access.tool('read_network',{operation:'network_semantic_search',input:JSON.stringify({query:'search',documents:['private']})});assert(bad.error);
 assert.equal((await access.tool('build_network',{operation:'network_semantic_search',input:'{}'})).error,'network_operation_unavailable');
 await assert.rejects(semanticNetworkSearch({query:'   '},deps()),/invalid_semantic_search_query/);
});

test('authenticated admission binds exact model bytes and never sends network credentials to the model',async()=>{
 const calls:any[]=[],token='cln_'+'a'.repeat(43),ticket='cGF5bG9hZA.c2lnbmF0dXJl';
 const access=createNetworkAccess({now,issueSession:async()=>({token,expiresAt:now()+3600000}),request:async(url:any,options:any)=>{
  const u=String(url);calls.push({url:u,...options});
  if(u.includes('/v1/public/infrastructure/releases/'))return Response.json(approval());
  if(u.includes('/infrastructure?'))return Response.json(resources());
  if(u.includes('/api/network-context'))return Response.json(inventory(1));
  if(u.endsWith('/search-admission')){
   assert.equal(options.headers.authorization,'Bearer '+token);
   return Response.json({ticket,service:s.projectId,expiresAt:now()+20000});
  }
  if(u==='https://abc123xyz-8080.proxy.runpod.net/v1/search'){
   assert.equal(options.headers.authorization,'Claus '+ticket);
   const admission=calls.find(c=>c.url.endsWith('/search-admission'));
   assert.equal(JSON.parse(admission.body).bodyHash,createHash('sha256').update(options.body).digest('hex'));
   assert(!JSON.stringify(options).includes(token));
   return Response.json({model:s.model,results:[{id:'prj_0',score:0.5}]});
  }
  throw Error('unexpected '+u);
 }});
 const result=await access.call('network_semantic_search',{query:'find a project'});
 assert.equal(result.results.length,1);
 assert.equal(calls.filter(c=>c.url.includes('proxy.runpod.net')).length,1);
});


test('UTF-8 catalogue batches stay within 64 KiB without dropping projects',async()=>{
 const value=inventory(20);
 for(const p of value.projects)p.description='漢'.repeat(2048);
 const d=deps(value),r=await semanticNetworkSearch({query:'查找服務',limit:3},d);
 assert(d.posts[0].body.documents.length<15);
 assert(d.posts.every(p=>Buffer.byteLength(JSON.stringify(p.body),'utf8')<=65536));
 assert.deepEqual(d.posts.flatMap(p=>p.body.documents.map((v:any)=>v.id)),value.projects.map(p=>p.id));
 assert.equal(r.coverage.projectsSearched,20);assert.equal(r.coverage.complete,false);
 assert.deepEqual(r.results.map(x=>x.projectId),['prj_19','prj_18','prj_17']);
});
