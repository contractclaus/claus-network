import test from 'node:test';
import assert from 'node:assert/strict';
import {createFlyInfrastructure,createRunpodInfrastructure} from '../adapters/infrastructure.mjs';
import {digest} from '../src/shared/index.mjs';

function work(provider){return {id:digest('operation'),projectId:'project',desired:'running',leaseUntil:Date.now()+300000,createdAt:Date.now(),profile:{id:'profile',enabled:true,provider,accountId:'account',asset:'USDC',fundingAccount:'fund',permissionHash:digest('authority'),maxLeaseSeconds:3600,maxPerLease:'100',maxActive:1,imagePrefixes:['ghcr.io/contractclaus/'],regions:['ams'],maxCpu:4,maxMemoryMiB:8192,maxStorageGiB:0,gpuTypes:['test-gpu']},manifest:{version:1,mode:'job',image:'ghcr.io/contractclaus/app@sha256:'+'a'.repeat(64),region:'ams',cpu:1,memoryMiB:1024,gpu:provider==='runpod'?'test-gpu':null,port:null,healthPath:null,command:[],storageGiB:0,releaseHash:digest('release')}};}
const json=(v,status=200)=>new Response(status===204?null:JSON.stringify(v),{status,headers:{'content-type':'application/json'}});
test('Fly refuses a different organization before creating or stopping anything',async()=>{
 const w=work('fly'),calls=[];
 const api=createFlyInfrastructure({token:'test',organization:'claus-network',accountId:'account',projectApps:{project:{app:'claus-app',isolatedNetwork:true}},request:async(url,init)=>{calls.push(init.method);return json({organization:{slug:'someone-else'}});}});
 await assert.rejects(api.create(w),{code:'infrastructure_account_mismatch'});
 await assert.rejects(api.stop(w),{code:'infrastructure_account_mismatch'});
 assert.deepEqual(calls,['GET','GET']);
});
test('Fly adopts an exact existing resource and never recreates it; altered images are rejected',async()=>{
 const w=work('fly');let creates=0;
 const m={id:'machine',name:'claus-'+w.id.replace('sha256:','').slice(0,32),state:'started',config:{image:w.manifest.image,metadata:{'claus.operation':w.id,'claus.project':w.projectId}}};
 const api=createFlyInfrastructure({token:'test',organization:'claus-network',accountId:'account',projectApps:{project:{app:'claus-app',isolatedNetwork:true}},request:async(url,init)=>{if(init.method!=='GET')creates++;return json(url.endsWith('/claus-app')?{organization:{slug:'claus-network'}}:[m]);}});
 assert.equal((await api.create(w)).providerResourceId,'machine');assert.equal(creates,0);
 m.config.image='ghcr.io/other/app:latest';await assert.rejects(api.inspect(w),{code:'infrastructure_resource_mismatch'});
});
test('Runpod v2 follows the inventory cursor and adopts the original pod without a new billable request',async()=>{
 const w=work('runpod'),calls=[];w.manifest.region='US-KS-2';w.profile.regions=['US-KS-2'];
 const p={id:'pod',name:'claus-'+w.id.replace('sha256:','').slice(0,32),image:w.manifest.image,status:'RUNNING',env:{CLAUS_RESOURCE_ID:w.id,CLAUS_PROJECT_ID:w.projectId}};
 const api=createRunpodInfrastructure({token:'test',accountId:'account',request:async(url,init)=>{calls.push({url,method:init.method});return json(url.includes('cursor=next')?{pods:[p],pagination:{hasNextPage:false}}:{pods:[],pagination:{hasNextPage:true,nextCursor:'next'}});}});
 assert.equal((await api.create(w)).providerResourceId,'pod');assert(calls.every(c=>c.method==='GET'));assert(calls.at(-1).url.includes('/v2/pods'));
});
test('Runpod logs decode bounded SSE lines instead of waiting for a JSON response',async()=>{
 const w=work('runpod');
 const p={id:'pod',name:'claus-'+w.id.replace('sha256:','').slice(0,32),image:w.manifest.image,status:'RUNNING',env:{CLAUS_RESOURCE_ID:w.id,CLAUS_PROJECT_ID:w.projectId}};
 const api=createRunpodInfrastructure({token:'test',accountId:'account',request:async(url,init)=>{
  assert.equal(init.method,'GET');
  if(!url.includes('/logs?'))return json({pods:[p],pagination:{hasNextPage:false}});
  assert.equal(init.headers.accept,'text/event-stream');
  return new Response('id: 1\r\ndata: {"source":"container","line":"model ready ✓","ts":"2026-10-17T00:00:00Z"}\r\n\r\n: heartbeat\n\ndata: {"line":"'+('x'.repeat(15000))+'"}\n\n',{headers:{'content-type':'text/event-stream'}});
 }});
 assert.equal(await api.logs(w),'model ready ✓\n');
});
test('missing Runpod resource remains unknown, and an incomplete inventory cannot trigger creation',async()=>{
 const w=work('runpod');let writes=0;
 const request=async(url,init)=>{if(init.method!=='GET')writes++;return json({pods:[],pagination:{hasNextPage:false}});};
 const api=createRunpodInfrastructure({token:'test',accountId:'account',request});
 assert.equal((await api.inspect(w)).outcome,'unknown');assert.equal(writes,0);
 const incomplete=createRunpodInfrastructure({token:'test',accountId:'account',request:async()=>json({pods:[],pagination:{hasNextPage:true,nextCursor:'same'}})});
 await assert.rejects(incomplete.create(w),{code:'infrastructure_cursor_invalid'});
});
