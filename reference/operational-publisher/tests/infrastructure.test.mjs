import test from 'node:test';
import assert from 'node:assert/strict';
import {createInfrastructureBroker,digest} from '../src/infrastructure/broker.mjs';
import {ProviderError,runpodDriver,flyDriver,providerRequest} from '../src/infrastructure/providers.mjs';

async function fixture(){
 let at=1000000,creates=0,deletes=0,found=null,lost=false;
 const rows=new Map(),clone=v=>structuredClone(v);
 const ledger={
  get:async id=>clone(rows.get(id)),
  reserveOci:async(id,input,result)=>{const prior=rows.get(id);if(prior)assert.equal(prior.inputHash,digest(input));else rows.set(id,{id,inputHash:digest(input),result:clone(result)});return {created:!prior,row:clone(rows.get(id))};},
  infrastructureLock:async(id,token,now)=>{const row=rows.get(id);if(!row||row.result.controllerLease?.until>now)return null;row.result.controllerLease={token,until:now+120000};return clone(row);},
  infrastructureSave:async(id,token,result,now)=>{const r=rows.get(id);assert.equal(r.result.controllerLease.token,token);assert(r.result.controllerLease.until>now);r.result=clone({...result,controllerLease:{token,until:now+120000}});},
  infrastructureUnlock:async(id,token)=>{const r=rows.get(id);if(r.result.controllerLease?.token===token)delete r.result.controllerLease;},
  infrastructureDue:async()=>[...rows.values()].filter(r=>r.id.startsWith('infrastructure:')&&!r.result.terminal&&r.result.phase!=='prepared')
 };
 const p={id:'gpu',provider:'runpod',accountId:'own',asset:'USD',maxLeaseSeconds:3600,maxPerLease:'1000000'};
 const manifest={image:'ghcr.io/contractclaus/app@sha256:'+'a'.repeat(64),releaseHash:digest('release')};
 const config={enabled:true,profiles:[{id:'gpu',provider:'runpod',accountId:'own',profileHash:digest(p),enabled:true,maxHourlyMicroUsd:'1000000'}],releases:[{enabled:true,projectId:'p',manifestHash:digest(manifest),releaseHash:manifest.releaseHash,reviewHash:digest('review')}]};
 const driver={quote:async()=>({hourlyMicroUsd:'1000000'}),readiness:async()=>({authenticated:true}),create:async()=>{creates++;found={providerResourceId:'pod1',ready:true,terminal:false};if(lost)throw Error('lost');return found;},inspect:async()=>found??{outcome:'unknown'},stop:async()=>{deletes++;return {...found,terminal:true,ready:false,deletionConfirmed:true};},cost:async()=>({final:false,observedMicroUsd:'0'}),logs:async()=>''};
 const broker=createInfrastructureBroker({ledger,budget:async operation=>assert(["reserve","commit","cancel"].includes(operation)),config:()=>config,secret:()=> 's'.repeat(32),now:()=>at,drivers:{runpod:driver},releaseStatus:async w=>config.releases.some(r=>r.enabled&&r.projectId===w.projectId&&r.manifestHash===digest(w.manifest))});
 const call=(operation,input)=>broker.call({operation,input});
 const quote=async()=>{const i={projectId:'p',profile:p,manifest,leaseSeconds:300};const r=await call('quote',{...i,requestHash:digest(i)});return {id:digest('quote'+at),providerQuoteId:r.id,maximum:r.maximum,leaseSeconds:300};};
 const work={id:digest('resource'),projectId:'p',profile:p,manifest,quote:await quote(),createdAt:at,leaseUntil:at+300000,extensions:[]};
 return {broker,call,work,rows,driver,config,quote,advance:n=>at+=n,lose:()=>lost=true,creates:()=>creates,deletes:()=>deletes};
}

test('uncertain create is located by original identity without resubmission',async()=>{
 const f=await fixture();f.lose();await assert.rejects(f.call('create',f.work),/lost/);
 const recovered=await f.call('create',f.work);assert.equal(recovered.providerResourceId,'pod1');assert.equal(f.creates(),1);
});

test('concurrent dispatch cannot create twice and guard terminates only the bound resource',async()=>{
 const f=await fixture();let done;f.driver.create=async()=>new Promise(r=>done=r);
 const a=f.call('create',f.work);await new Promise(setImmediate);
 await assert.rejects(f.call('create',f.work),/resource_busy/);done({providerResourceId:'pod1',ready:true,terminal:false});await a;
 f.driver.inspect=async()=>({providerResourceId:'pod1',ready:true,terminal:false});f.advance(301000);
 await f.broker.guard();assert.equal(f.deletes(),1);
});

test('renewal is idempotent, binds all original fields and prevents a stale guard cutoff',async()=>{
 const f=await fixture();await f.call('create',f.work);f.advance(1000);
 const next={...f.work,leaseUntil:f.work.leaseUntil+300000,extensions:[{id:'renew',sequence:1,previousUntil:f.work.leaseUntil,quote:await f.quote()}]};
 await f.call('extend',next);await f.call('extend',next);
 await assert.rejects(f.call('extend',{...next,manifest:{...next.manifest,image:'different'}}),/work_changed/);
 f.advance(301000);await f.broker.guard();assert.equal(f.deletes(),0);
 f.config.enabled=false;await f.broker.guard();assert.equal(f.deletes(),1);
});

test('authoritative rejection settles zero while provider 5xx remains unknown',async()=>{
 const f=await fixture();f.driver.create=async()=>{throw new ProviderError(402,'provider_402');};
 const r=await f.call('create',f.work);assert.equal(r.receipt.actual,'0');assert.equal(r.terminal,true);
 const g=await fixture();g.driver.create=async()=>{throw new ProviderError(503,'provider_503');};
 await assert.rejects(g.call('create',g.work));const status=await g.call('inspect',g.work);assert.equal(status.receipt,undefined);assert.equal(status.terminal,false);
});

test('unreviewed releases and foreign profiles cannot receive provider quotes',async()=>{
 const f=await fixture();f.config.releases=[];await assert.rejects(f.quote(),/release_not_approved/);
});

test('withdrawing image approval stops the original running resource through the existing guardian',async()=>{
 const f=await fixture();await f.call('create',f.work);f.config.releases[0].enabled=false;
 await f.broker.guard();assert.equal(f.creates(),1);assert.equal(f.deletes(),1);
});

test('Fly price binds CPU, memory and region; projects cannot share a routing app',async()=>{
 let reads=0,creates=0;const request=async(_url,init)=>{if(init.method==='POST')creates++;else reads++;return Response.json({organization:{slug:'claus-network'}});};
 const d=flyDriver({token:()=> 'fixture',request}),work={projectId:'a',manifest:{cpu:1,memoryMiB:256,region:'ams',storageGiB:0,gpu:null}};
 const config={app:'project-a',projectId:'a',organization:'claus-network',rates:[{cpu:1,memoryMiB:256,region:'ams',hourlyMicroUsd:'9000',priceSource:'fixture'}]};
 const quote=await d.quote(work,config);assert.equal(quote.hourlyMicroUsd,'9000');assert.equal(reads,1);
 await assert.rejects(d.quote({...work,projectId:'b'},config),/project_app_not_isolated/);
 await assert.rejects(d.quote({...work,manifest:{...work.manifest,memoryMiB:65536}},config),/price_not_configured/);
 await assert.rejects(d.create({...work,manifest:{...work.manifest,cpu:64}},quote,config),/price_shape_mismatch/);assert.equal(creates,0);
});

test('Runpod CPU requests use v2 shape and a public application must pass health check',async()=>{
 const work={id:digest('resource'),manifest:{image:'ghcr.io/contractclaus/app@sha256:'+'a'.repeat(64),region:'EU-RO-1',cpu:2,memoryMiB:4096,gpu:null,port:8080,healthPath:'/health',command:['node','server.mjs']}};
 const calls=[];const request=async(url,init)=>{calls.push({url,init});return url.includes('/v2/')?Response.json({id:'pod123',name:'claus-'+work.id.slice(-40),image:work.manifest.image,status:'RUNNING',cost:.3}):new Response('',{status:503});};
 const d=runpodDriver({token:()=> 'private',request});const r=await d.create(work,{bootDiskGiB:10,cpuType:'cpu5c'});
 assert.equal(r.ready,false);assert.equal(calls[0].url,'https://api.runpod.io/v2/pods');
 const body=JSON.parse(calls[0].init.body);assert.deepEqual(body.cpu,{id:'cpu5c',vcpuCount:2});assert.equal(body.startSsh,false);assert.equal(body.env,undefined);
 assert.equal(Object.hasOwn(body,'globalNetworking'),false);
 assert.equal(calls[1].url,'https://pod123-8080.proxy.runpod.net/health');assert.equal(calls[1].init.headers,undefined);
 const gpuWork={...work,manifest:{...work.manifest,gpu:'NVIDIA A40'}};
 await d.create(gpuWork,{bootDiskGiB:30,cpuType:null});
 const gpuBody=JSON.parse(calls[2].init.body);assert.equal(gpuBody.globalNetworking,false);assert.equal(gpuBody.cpu,undefined);
});
test('Runpod ERROR is a stopped recoverable state, not an indefinitely provisioning pod',async()=>{
 const work={id:digest('error-pod'),manifest:{image:'example.com/claus/app@sha256:'+'a'.repeat(64),port:8080,healthPath:'/health'}};
 const d=runpodDriver({token:()=> 'fixture',request:async()=>Response.json({id:'pod1',name:'claus-'+work.id.slice(-40),image:work.manifest.image,status:'ERROR',cost:0.06})});
 const r=await d.inspect(work,{providerResourceId:'pod1'});assert.equal(r.stopped,true);assert.equal(r.terminal,false);assert.equal(r.ready,false);
});

test('oversized log responses fail closed and do not return partial secret-bearing payloads',async()=>{
 await assert.rejects(providerRequest(async()=>new Response('x'.repeat(17000)),'https://example.com','key',{stream:true}),/too_large/);
});

test('unexpected service stop resumes the same resource within its original funded lease',async()=>{
 const f=await fixture();f.work.manifest.mode='http';f.config.releases[0].manifestHash=digest(f.work.manifest);f.work.quote=await f.quote();let starts=0;
 f.driver.inspect=async()=>({providerResourceId:'pod1',state:'EXITED',stopped:true,terminal:false,ready:false});
 f.driver.resume=async w=>{assert.equal(w.id,f.work.id);starts++;return {providerResourceId:'pod1',state:'RUNNING',ready:true,terminal:false};};
 await f.call('create',f.work);const result=await f.call('inspect',f.work);assert.equal(result.ready,true);assert.equal(starts,1);assert.equal(f.creates(),1);
 await f.call('inspect',f.work);assert.equal(starts,1);
});
test('requested stops and one-shot jobs are not automatically restarted',async()=>{
 for(const mode of ['http','job']){const f=await fixture();f.work.manifest.mode=mode;f.config.releases[0].manifestHash=digest(f.work.manifest);f.work.quote=await f.quote();let starts=0;
 f.driver.inspect=async()=>({providerResourceId:'pod1',state:'EXITED',stopped:true,terminal:false,ready:false});f.driver.stop=f.driver.inspect;f.driver.resume=async()=>{starts++;return {}};
 await f.call('create',f.work);if(mode==='http')await f.call('stop',f.work);await f.call('inspect',f.work);assert.equal(starts,0);}
});
test('expired leases remove stopped services instead of restarting them',async()=>{
 const f=await fixture();f.work.manifest.mode='http';f.config.releases[0].manifestHash=digest(f.work.manifest);f.work.quote=await f.quote();let starts=0;
 f.driver.inspect=async()=>({providerResourceId:'pod1',state:'EXITED',stopped:true,terminal:false,ready:false});f.driver.resume=async()=>{starts++;return {}};
 await f.call('create',f.work);f.advance(301000);await f.call('inspect',f.work);assert.equal(starts,0);assert.equal(f.deletes(),1);
});


test('readiness exposes real CPU regions before a paid runtime review',async()=>{
 const calls=[];const d=runpodDriver({token:()=> 'private',now:()=>123,request:async(url,options)=>{calls.push({url,method:options.method});return new Response(JSON.stringify(url.includes('/catalog/')?{id:'cpu3c',vcpu:{min:2,max:32},ramGbPerVcpu:2,price:{securePerVcpu:0.03},dataCenters:[{id:'US-GA-2',availability:'HIGH'},{id:'EU-NL-1',availability:'NONE'}]}:{pods:[]}));}});
 const r=await d.readiness({cpuType:'cpu3c'});assert.equal(r.authenticated,true);assert.deepEqual(r.capacity.availableRegions,['US-GA-2']);assert.equal(r.capacity.hourlyMicroUsdPerVcpu,'30000');assert(calls.every(x=>x.method==='GET'));
});

test('GPU readiness reads only configured GPU types and preserves partial catalog failures',async()=>{
 const urls=[];
 const driver=runpodDriver({token:()=> 'private',now:()=>1234,request:async url=>{
  urls.push(url);
  if(url.endsWith('/pods?limit=1'))return Response.json({pods:[]});
  if(url.includes('missing'))return Response.json({error:'unavailable'},{status:503});
  assert(url.includes('/catalog/gpus/'));
  return Response.json({id:'GPU A',price:{secure:0.245},dataCenters:[{id:'US-GA-2',availability:'HIGH'},{id:'EU-NL-1',availability:'NONE'}]});
 }});
 const result=await driver.readiness({cpuType:'cpu3c',gpuTypes:['GPU A','missing','GPU A']});
 assert.equal(result.authenticated,true);assert.equal(result.capacity.kind,'gpu');
 assert.deepEqual(result.capacity.items,[{gpuType:'GPU A',availableRegions:['US-GA-2'],hourlyMicroUsd:'245000',catalogAvailable:true},{gpuType:'missing',catalogAvailable:false,error:'catalog_unavailable'}]);
 assert.equal(urls.length,3);assert(!urls.some(u=>u.includes('/catalog/cpus/')));
});

test('confirmed provider rejection retains bounded useful error details',async()=>{
 const f=await fixture();f.driver.create=async()=>{throw new ProviderError(400,'provider_400',null,{title:'Bad request',detail:'CPU pods reject globalNetworking',errors:[]})};
 const rejected=await f.call('create',f.work);assert.equal(rejected.error,'infrastructure_provider_400');assert.equal(rejected.errorDetails.detail,'CPU pods reject globalNetworking');assert.equal(rejected.receipt.actual,'0');assert.equal(rejected.terminal,true);
 await assert.rejects(providerRequest(async()=>Response.json({title:'Bad request',detail:'Bearer do-not-return\n'+'.'.repeat(600),errors:['$.cpu invalid']},{status:400}),'https://api.runpod.io/v2/pods','private',{method:'POST',body:{}}),e=>e.status===400&&e.details.detail.length<=500&&!e.details.detail.includes('do-not-return')&&e.details.errors[0]==='$.cpu invalid');
});
