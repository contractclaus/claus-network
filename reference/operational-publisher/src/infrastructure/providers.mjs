import {flyApps} from './fly-target.mjs';
export const check=(value,code)=>{if(!value)throw Error('infrastructure_'+code);};
export class ProviderError extends Error {
  constructor(status,code,retryAt=null,details=null){super('infrastructure_'+code);this.status=status;this.retryAt=retryAt;this.details=details;}
}
export const microUsd=value=>{
  check(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<1000000,'price_invalid');
  return BigInt(Math.ceil(value*1000000));
};
export async function providerRequest(request,url,token,{method='GET',body,stream=false}={}){
  const response=await request(url,{method,redirect:'error',signal:AbortSignal.timeout(stream?5000:18000),headers:{authorization:'Bearer '+token,accept:stream?'text/event-stream':'application/json',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  if(!response.ok){
    const retry=Number(response.headers.get('retry-after'));
    let details=null;
    const reader=response.body?.getReader();
    if(reader)try{
      let size=0;const chunks=[];
      for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>8192)break;chunks.push(part.value);}
      if(size<=8192){const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const clean=v=>typeof v==='string'?v.replace(/[\u0000-\u001f]/g,' ').replace(/Bearer\s+\S+/gi,'Bearer [redacted]').slice(0,500):null;
        details={title:clean(value.title),detail:clean(value.detail),errors:Array.isArray(value.errors)?value.errors.slice(0,5).map(clean).filter(Boolean):[]};
      }
    }catch{/* Malformed provider errors do not hide the original status. */}
    finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    throw new ProviderError(response.status,'provider_'+response.status,Number.isFinite(retry)&&retry>0?Date.now()+Math.min(retry,900)*1000:null,details);
  }
  if(response.status===204)return null;
  const reader=response.body?.getReader();check(reader,'provider_response_missing');let length=0;const parts=[];
  try{while(true){const chunk=await reader.read();if(chunk.done)break;length+=chunk.value.length;check(length<= (stream?16000:2000000),'provider_response_too_large');parts.push(chunk.value);if(stream&&length>=12000)break;}}
  catch(error){if(!stream||parts.length===0||error.message==='infrastructure_provider_response_too_large')throw error;}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const raw=Buffer.concat(parts).toString('utf8');return stream?raw:JSON.parse(raw);
}

export function runpodDriver({token,request=fetch,now=()=>Date.now()}){
  const api=(path,options)=>providerRequest(request,'https://api.runpod.io/v2'+path,token(),options);
  function matches(pod,work){
    check(typeof pod?.id==='string'&&/^[a-zA-Z0-9]+$/.test(pod.id)&&pod.name==='claus-'+work.id.slice(-40),'resource_identity_mismatch');
    check(pod.image===work.manifest.image,'resource_image_changed');
    return pod;
  }
  function observation(pod,work){
    matches(pod,work);
    const terminated=pod.status==='TERMINATED',running=pod.status==='RUNNING';
    const stopped=terminated||pod.status==='EXITED'||pod.status==='ERROR';
    const endpoint=work.manifest.port&&!terminated?'https://'+pod.id+'-'+work.manifest.port+'.proxy.runpod.net':null;
    const rate=pod.cost===undefined?null:microUsd(pod.cost).toString();
    return {providerResourceId:pod.id,state:pod.status,ready:running&&!work.manifest.port,terminal:terminated,stopped,endpoint,hourlyMicroUsd:rate,storageRetained:!terminated,costFinal:false};
  }
  async function observe(pod,work){
    const value=observation(pod,work);
    if(pod.status==='RUNNING'&&work.manifest.port){
      try{const health=await request(value.endpoint+work.manifest.healthPath,{method:'GET',redirect:'error',signal:AbortSignal.timeout(5000)});value.ready=health.ok;await health.body?.cancel();}catch{value.ready=false;}
    }
    return value;
  }
  return {
    async fundingHistory({from,to}){
      check(Number.isSafeInteger(from)&&Number.isSafeInteger(to)&&from>=0&&to>from&&to<=now()+30000&&to-from<=7*86400000,'funding_window_invalid');
      const value=await providerRequest(request,'https://api.runpod.io/graphql',token(),{method:'POST',body:{
        query:'query Funding($from: DateTime!, $to: DateTime!) { myself { id clientBalance stripeReloadHistory(startDate: $from, endDate: $to) { id amount type medium transactionCompletedAt } } }',
        variables:{from:new Date(from).toISOString(),to:new Date(to).toISOString()}
      }});
      const user=value?.data?.myself;
      check(!value?.errors?.length&&typeof user?.id==='string'&&user.id.length>0&&Array.isArray(user.stripeReloadHistory)&&user.stripeReloadHistory.length<=500,'funding_response_invalid');
      const receipts=[];
      for(const r of user.stripeReloadHistory){
        // Debits or other funding rails need their own reconciliation policy.
        check(r.type==='RELOAD'&&r.medium==='STRIPE','funding_event_requires_review');
        const completedAt=Date.parse(r.transactionCompletedAt);
        check(typeof r.id==='string'&&r.id.length>0&&r.id.length<=256&&Number.isSafeInteger(completedAt)&&completedAt>=from&&completedAt<=to&&typeof r.amount==='number'&&r.amount>0&&r.amount<1000000,'funding_receipt_invalid');
        const cents=Math.round(r.amount*100);
        check(Math.abs(r.amount*100-cents)<0.000001,'funding_amount_invalid');
        receipts.push({id:r.id,amount:(BigInt(cents)*10000n).toString(),completedAt,type:r.type,medium:r.medium});
      }
      check(typeof user.clientBalance==='number'&&Number.isFinite(user.clientBalance)&&user.clientBalance>=0&&user.clientBalance<1000000,'funding_balance_invalid');
      return {providerAccountId:user.id,from,to,observedAt:now(),balanceMicroUsd:Math.floor(user.clientBalance*1000000).toString(),receipts};
    },
    async readiness(config={}){
      const list=await api('/pods?limit=1');check(Array.isArray(list.pods),'provider_shape_invalid');
      if(config.gpuTypes?.length){
        const types=[...new Set(config.gpuTypes)];
        check(types.length<=8&&types.every(id=>typeof id==='string'&&id.length<=120),'gpu_catalog_invalid');
        const results=await Promise.allSettled(types.map(async id=>{
          const item=await api('/catalog/gpus/'+encodeURIComponent(id)+'?include=AVAILABILITY&product=POD&cloud=SECURE');
          check(item.id===id&&Array.isArray(item.dataCenters),'provider_shape_invalid');
          const rate=microUsd(item.price?.secure).toString();check(BigInt(rate)>0n,'price_invalid');
          return {gpuType:id,availableRegions:item.dataCenters.filter(d=>['LOW','MEDIUM','HIGH'].includes(d.availability)).map(d=>d.id),hourlyMicroUsd:rate};
        }));
        return {authenticated:true,capacity:{kind:'gpu',observedAt:now(),items:results.map((r,i)=>r.status==='fulfilled'?{...r.value,catalogAvailable:true}:{gpuType:types[i],catalogAvailable:false,error:'catalog_unavailable'}),meaning:'Current GPU availability and catalog price; each workload still needs an approved exact image, region and funded quote.'}};
      }
      if(!config.cpuType)return {authenticated:true};
      const item=await api('/catalog/cpus/'+encodeURIComponent(config.cpuType)+'?include=AVAILABILITY&product=POD&cloud=SECURE');
      check(item.id===config.cpuType&&Array.isArray(item.dataCenters)&&Number.isFinite(item.price?.securePerVcpu)&&item.price.securePerVcpu>0,'provider_shape_invalid');
      return {authenticated:true,capacity:{kind:'cpu',observedAt:now(),cpuType:item.id,minVcpu:item.vcpu?.min??null,maxVcpu:item.vcpu?.max??null,ramGbPerVcpu:item.ramGbPerVcpu??null,availableRegions:item.dataCenters.filter(d=>['LOW','MEDIUM','HIGH'].includes(d.availability)).map(d=>d.id),hourlyMicroUsdPerVcpu:microUsd(item.price.securePerVcpu).toString(),meaning:'Current capacity only; select a permitted available region before preparing the exact runtime release and its independent review.'}};
    },
    async quote(work,config){
      const m=work.manifest;check(m.storageGiB===0,'persistent_storage_requires_profile');
      const gpu=m.gpu!==null;check(gpu||config.cpuType,'cpu_type_not_configured');
      const item=await api('/catalog/'+(gpu?'gpus/':'cpus/')+encodeURIComponent(gpu?m.gpu:config.cpuType)+'?include=AVAILABILITY&product=POD&cloud=SECURE');
      check(item.id===(gpu?m.gpu:config.cpuType),'catalog_identity_mismatch');
      const region=item.dataCenters?.find(d=>d.id===m.region);
      check(region&&['LOW','MEDIUM','HIGH'].includes(region.availability),'capacity_unavailable');
      if(!gpu)check((m.cpu&(m.cpu-1))===0&&m.cpu>=2&&m.cpu>=item.vcpu.min&&m.cpu<=item.vcpu.max&&m.memoryMiB<=item.ramGbPerVcpu*m.cpu*1024,'cpu_shape_unavailable');
      const base=microUsd(gpu?item.price?.secure:item.price?.securePerVcpu*m.cpu);
      check(base>0n,'price_invalid');
      // The protected configuration reserves boot disk and shutdown headroom.
      const hourly=base+BigInt(config.diskHourlyMicroUsd);
      check(hourly<=BigInt(config.maxHourlyMicroUsd),'price_over_limit');
      return {hourlyMicroUsd:hourly.toString(),providerHourlyMicroUsd:base.toString(),bootDiskGiB:config.bootDiskGiB,cpuType:gpu?null:config.cpuType,priceObservedAt:now()};
    },
    async create(work,quote){
      const m=work.manifest;
      const pod=await api('/pods',{method:'POST',body:{name:'claus-'+work.id.slice(-40),image:m.image,cloud:'SECURE',dataCenterIds:[m.region],disk:quote.bootDiskGiB,ports:m.port?[m.port+'/http']:[],entrypoint:m.command.length?m.command:undefined,startSsh:false,startJupyter:false,...(m.gpu?{globalNetworking:false}:{}),...(m.gpu?{gpu:{id:m.gpu,count:1,minVcpuCountPerGpu:m.cpu,minRamPerGpu:Math.ceil(m.memoryMiB/1024)}}:{cpu:{id:quote.cpuType,vcpuCount:m.cpu}})}});
      return observe(pod,work);
    },
    async inspect(work,checkpoint){
      if(checkpoint.providerResourceId){
        try{return observe(await api('/pods/'+encodeURIComponent(checkpoint.providerResourceId)),work);}
        catch(e){if(e.status===404&&(checkpoint.deletionConfirmed||checkpoint.deletionRequested))return {providerResourceId:checkpoint.providerResourceId,state:'TERMINATED',terminal:true,stopped:true,ready:false,storageRetained:false,costFinal:false};throw e;}
      }
      // Search every page, persisting the cursor. An empty page is never proof
      // that an uncertain create did not happen.
      const value=await api('/pods?limit=100'+(checkpoint.searchCursor?'&cursor='+encodeURIComponent(checkpoint.searchCursor):''));
      check(Array.isArray(value.pods)&&value.pagination,'provider_shape_invalid');
      const matches=value.pods.filter(p=>p.name==='claus-'+work.id.slice(-40));check(matches.length<=1,'duplicate_resource');
      if(matches.length)return observe(matches[0],work);
      return {state:'unknown',outcome:'unknown',ready:false,terminal:false,searchCursor:value.pagination.hasNextPage?value.pagination.nextCursor:null};
    },
    async stop(work,checkpoint,remove){
      check(checkpoint.providerResourceId,'resource_not_identified');
      // Bind the live resource before every destructive operation.
      const path='/pods/'+encodeURIComponent(checkpoint.providerResourceId);
      try{matches(await api(path),work);}catch(e){if(e.status===404&&(checkpoint.deletionConfirmed||checkpoint.deletionRequested))return this.inspect(work,checkpoint);throw e;}
      if(remove){await api(path,{method:'DELETE'});return {providerResourceId:checkpoint.providerResourceId,state:'TERMINATED',ready:false,terminal:true,stopped:true,storageRetained:false,deletionConfirmed:true,costFinal:false};}
      const pod=await api(path+'/action',{method:'POST',body:{action:'stop'}});return observe(pod,work);
    },
    async resume(work,checkpoint){
      check(checkpoint.providerResourceId,'resource_not_identified');
      const path='/pods/'+encodeURIComponent(checkpoint.providerResourceId);
      matches(await api(path),work);
      return observe(await api(path+'/action',{method:'POST',body:{action:'start'}}),work);
    },
    async logs(work,checkpoint){
      check(checkpoint.providerResourceId,'resource_not_identified');
      matches(await api('/pods/'+encodeURIComponent(checkpoint.providerResourceId)),work);
      return api('/pods/'+encodeURIComponent(checkpoint.providerResourceId)+'/logs',{stream:true});
    },
    async cost(work,checkpoint){
      if(!checkpoint.providerResourceId)return null;
      const end=new Date(now()).toISOString(),start=new Date(work.createdAt-60000).toISOString();
      const r=await api('/billing/pods?podId='+encodeURIComponent(checkpoint.providerResourceId)+'&startTime='+encodeURIComponent(start)+'&endTime='+encodeURIComponent(end)+'&bucketSize=hour');
      check(r.metadata?.query?.podId===checkpoint.providerResourceId&&Array.isArray(r.records),'billing_scope_invalid');
      check(r.records.every(x=>x.podId===checkpoint.providerResourceId),'billing_scope_invalid');
      // Provider history is delayed and has no final-invoice signal. Never
      // release a reservation solely because an incomplete bucket reads zero.
      return {observedMicroUsd:microUsd(r.metadata.totals.totalAmount).toString(),observedAt:now(),final:false,source:'runpod-billing-history'};
    }
  };
}

export function flyDriver({token,request=fetch}){
  const apps=flyApps({request,token});
  const api=(path,options)=>providerRequest(request,'https://api.machines.dev/v1'+path,token(),options);
  const appPath=config=>'/apps/'+encodeURIComponent(config.app);
  function project(work,config){check(config.projectId===work.projectId&&/^[a-z0-9][a-z0-9-]{2,62}$/.test(config.app??''),'project_app_not_isolated');}
  async function account(config){const app=await api(appPath(config));check(app.organization?.slug===config.organization,'provider_account_mismatch');return app;}
  function matches(machine,work){check(machine?.config?.metadata?.claus_resource===work.id&&machine.config.metadata.claus_project===work.projectId,'resource_identity_mismatch');check(machine.config.image===work.manifest.image,'resource_image_changed');return machine;}
  function observation(machine,work,config){matches(machine,work);return {providerResourceId:machine.id,state:machine.state,ready:machine.state==='started'&&(!work.manifest.port||(machine.checks??[]).length>0&&(machine.checks??[]).every(x=>x.status==='passing')),terminal:machine.state==='destroyed',stopped:['stopped','destroyed'].includes(machine.state),endpoint:work.manifest.port?'https://'+config.app+'.fly.dev':null,storageRetained:machine.state!=='destroyed',costFinal:false};}
  return {
    async readiness(config){if(!config.app){check(config.organization==='claus-network','provider_account_mismatch');const list=await api('/apps?org_slug='+encodeURIComponent(config.organization));check(Array.isArray(list.apps),'provider_shape_invalid');return {authenticated:true,organization:config.organization,projectIsolationConfigured:false};}await account(config);return {authenticated:true,projectId:config.projectId??null,projectIsolationConfigured:typeof config.projectId==='string'};},
    async quote(work,config){
      project(work,config);const m=work.manifest;check(m.storageGiB===0&&!m.gpu,'fly_shape_unavailable');
      // A single small-machine price must not authorize every size in a profile.
      const rate=config.rates?.find(r=>r.cpu===m.cpu&&r.memoryMiB===m.memoryMiB&&r.region===m.region);
      check(rate&&/^[1-9][0-9]*$/.test(rate.hourlyMicroUsd??'')&&typeof rate.priceSource==='string'&&rate.priceSource.length>0,'price_not_configured');
      if(config.projectIsolation===true){await apps.inspect(config);}else await account(config);return {hourlyMicroUsd:rate.hourlyMicroUsd,priceSource:rate.priceSource,bootDiskGiB:0,shape:{cpu:m.cpu,memoryMiB:m.memoryMiB,region:m.region}};
    },
    async create(work,quote,config){project(work,config);const m=work.manifest;check(quote.shape?.cpu===m.cpu&&quote.shape.memoryMiB===m.memoryMiB&&quote.shape.region===m.region,'price_shape_mismatch');if(config.projectIsolation===true)await apps.prepare(config,{publicHttp:!!m.port});await account(config);const machine=await api(appPath(config)+'/machines',{method:'POST',body:{name:'claus-'+work.id.slice(-40),region:m.region,config:{image:m.image,metadata:{claus_resource:work.id,claus_project:work.projectId},init:m.command.length?{exec:m.command}:{},guest:{cpu_kind:'shared',cpus:m.cpu,memory_mb:m.memoryMiB},restart:{policy:m.mode==='job'?'no':'always'},auto_destroy:false,services:m.port?[{protocol:'tcp',internal_port:m.port,ports:[{port:443,handlers:['tls','http']}],autostop:false,autostart:false,}]:[],checks:m.port?{readiness:{type:'http',port:m.port,path:m.healthPath,method:'GET',interval:'30s',timeout:'5s'}}:{}}}});return observation(machine,work,config);},
    async inspect(work,checkpoint,config){if(checkpoint.providerResourceId){try{return observation(await api(appPath(config)+'/machines/'+encodeURIComponent(checkpoint.providerResourceId)),work,config);}catch(e){if(e.status===404&&(checkpoint.deletionConfirmed||checkpoint.deletionRequested))return {providerResourceId:checkpoint.providerResourceId,state:'destroyed',terminal:true,stopped:true,ready:false,storageRetained:false,costFinal:false};throw e;}}
      const machines=await api(appPath(config)+'/machines?include_deleted=true');check(Array.isArray(machines),'provider_shape_invalid');const found=machines.filter(x=>x.config?.metadata?.claus_resource===work.id);check(found.length<=1,'duplicate_resource');return found.length?observation(found[0],work,config):{state:'unknown',outcome:'unknown',ready:false,terminal:false};},
    async stop(work,checkpoint,remove,config){check(checkpoint.providerResourceId,'resource_not_identified');const path=appPath(config)+'/machines/'+encodeURIComponent(checkpoint.providerResourceId);let m;try{m=matches(await api(path),work);}catch(e){if(e.status===404&&(checkpoint.deletionConfirmed||checkpoint.deletionRequested))return this.inspect(work,checkpoint,config);throw e;}
      if(remove){await api(path+'?force=true',{method:'DELETE'});return {providerResourceId:m.id,state:'destroyed',terminal:true,stopped:true,ready:false,storageRetained:false,deletionConfirmed:true,costFinal:false};}
      await api(path+'/stop',{method:'POST',body:{signal:'SIGTERM',timeout:'30s'}});return {providerResourceId:m.id,state:'stopping',terminal:false,ready:false,storageRetained:true,costFinal:false};},
    async resume(work,checkpoint,config){
      const path=appPath(config)+'/machines/'+encodeURIComponent(checkpoint.providerResourceId);
      matches(await api(path),work);await api(path+'/start',{method:'POST',body:{}});
      return observation(await api(path),work,config);
    },
    async logs(work,checkpoint,config){const m=matches(await api(appPath(config)+'/machines/'+encodeURIComponent(checkpoint.providerResourceId)),work);return JSON.stringify({state:m.state,events:m.events??[],checks:m.checks??[],applicationLogsAvailable:false}).slice(0,16000);},
    async cost(){return {final:false,source:'provider-invoice-required'};}
  };
}
