import test from 'node:test';import assert from 'node:assert/strict';
import {runpodDriver,providerRequest} from '../src/infrastructure/providers.mjs';
const work={id:'sha256:'+'a'.repeat(64),manifest:{image:'ghcr.io/contractclaus/model@sha256:'+'b'.repeat(64),gpu:'GPU A',gpuCount:4,minimumVramGiB:48,cpu:16,memoryMiB:65536,region:'EU-NL-1',port:null,command:[],storageGiB:0}};
const config={maxGpuCount:8,bootDiskGiB:20,diskHourlyMicroUsd:'1000',maxHourlyMicroUsd:'10000000'};
test('GPU quote reserves every device and dispatches total host requirements per GPU',async()=>{
 let sent;const d=runpodDriver({token:()=> 'fixture',request:async(url,init)=>{
  if(url.includes('/catalog/'))return Response.json({id:'GPU A',memory:48,maxCount:{secure:8},price:{secure:1.25},dataCenters:[{id:'EU-NL-1',availability:'HIGH'}]});
  sent=JSON.parse(init.body);return Response.json({id:'pod123',name:sent.name,image:sent.image,status:'RUNNING',cost:5.001});
 }});
 const q=await d.quote(work,config);assert.equal(q.providerHourlyMicroUsd,'5000000');assert.equal(q.hourlyMicroUsd,'5001000');assert.equal(q.gpuCount,4);
 await d.create(work,q);assert.deepEqual(sent.gpu,{id:'GPU A',count:4,minVcpuCountPerGpu:4,minRamPerGpu:16});
 await assert.rejects(d.quote({...work,manifest:{...work.manifest,minimumVramGiB:80}},config),/gpu_vram_unavailable/);
 await assert.rejects(d.quote(work,{...config,maxHourlyMicroUsd:'2000000'}),/price_over_limit/);
 await assert.rejects(d.quote(work,{...config,maxGpuCount:1}),/gpu_count_not_allowed/);
});
test('429 preserves a provider HTTP-date or numeric delay without capping it early',async()=>{
 const future=Date.now()+3600000;const date=new Date(future).toUTCString();
 await assert.rejects(providerRequest(async()=>Response.json({}, {status:429,headers:{'retry-after':date}}),'https://api.runpod.io/v2/pods','fixture'),e=>e.status===429&&e.retryAt===Date.parse(date));
 const before=Date.now();await assert.rejects(providerRequest(async()=>Response.json({}, {status:429,headers:{'retry-after':'1800'}}),'https://api.runpod.io/v2/pods','fixture'),e=>e.retryAt>=before+1800000);
});
