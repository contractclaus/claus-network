import {requireThat,text} from '../src/shared/index.mjs';
import {validateManifest,matchManifest} from '../src/infrastructure/manifest.mjs';

// This adapter receives already admitted operations. It never takes an API URL,
// account, secret, arbitrary request body or provider resource ID from an agent.
async function logLines(response) {
  requireThat(response.headers.get('content-type')?.includes('text/event-stream'),'infrastructure_log_format_invalid');
  const reader=response.body?.getReader();requireThat(reader,'infrastructure_empty_response');
  const decoder=new TextDecoder(),lines=[];let pending='',received=0,outputBytes=0;
  // The provider keeps SSE connections open indefinitely. A tool read is a
  // bounded snapshot, not a request to wait for the container to terminate.
  const timer=setTimeout(()=>{reader.cancel().catch(()=>{});},3000);
  try {
    for(;;){
      const {done,value}=await reader.read();if(done)break;
      received+=value.byteLength;requireThat(received<=128000,'infrastructure_response_too_large');
      pending+=decoder.decode(value,{stream:true});let boundary;
      while((boundary=pending.indexOf('\n'))!==-1){
        const line=pending.slice(0,boundary).replace(/\r$/,'');pending=pending.slice(boundary+1);
        if(!line.startsWith('data:'))continue;
        let event;try{event=JSON.parse(line.slice(5).trim());}catch{continue;}
        if(typeof event.line!=='string')continue;
        const entry=event.line+'\n',bytes=Buffer.byteLength(entry);
        if(outputBytes+bytes>15000)return lines.join('');
        lines.push(entry);outputBytes+=bytes;
      }
    }
    return lines.join('');
  } finally {clearTimeout(timer);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
function client(origin,token,request=fetch) {
  requireThat(typeof token==='string'&&token.length>0,'infrastructure_credential_missing');
  return async(method,path,body,{notFound=false,logs=false}={})=>{
    const response=await request(origin+path,{method,redirect:'error',headers:{authorization:'Bearer '+token,accept:logs?'text/event-stream':'application/json',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
    if(notFound&&response.status===404){await response.body?.cancel();return null;}
    if(!response.ok){await response.body?.cancel();throw Object.assign(Error('infrastructure_provider_response'),{code:response.status===429?'infrastructure_rate_limited':response.status===401||response.status===403?'infrastructure_access_unavailable':'infrastructure_provider_response',status:response.status});}
    if(response.status===204)return null;
    if(logs)return logLines(response);
    const reader=response.body?.getReader();requireThat(reader,'infrastructure_empty_response');let size=0;const parts=[];
    try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>1000000){await reader.cancel();throw Object.assign(Error('infrastructure_response_too_large'),{code:'infrastructure_response_too_large'});}parts.push(part.value);}}finally{reader.releaseLock();}
    const bytes=Buffer.concat(parts);return bytes.length?JSON.parse(bytes.toString()):null;
  };
}
const shortId=w=>'claus-'+w.id.replace('sha256:','').slice(0,32);
function check(w,provider,accountId){requireThat(w.profile.provider===provider&&w.profile.accountId===accountId,'infrastructure_account_mismatch');validateManifest(w.manifest);matchManifest(w.profile,w.manifest);}
function costing({quote,verifyRelease,verifyReceipt}){
  return {
    quote:async request=>{requireThat(typeof quote==='function','infrastructure_costing_not_configured');return quote(request);},
    verifyRelease:async value=>typeof verifyRelease==='function'&&await verifyRelease(value)===true,
    verifyReceipt:async(...args)=>typeof verifyReceipt==='function'&&await verifyReceipt(...args)===true
  };
}

export function createFlyInfrastructure({token,organization,accountId,projectApps,request=fetch,quote,verifyRelease,verifyReceipt,readReceipt}){
  text(organization);text(accountId);
  const call=client('https://api.machines.dev',token,request);
  const app=async w=>{
    check(w,'fly',accountId);requireThat(w.manifest.gpu===null&&w.manifest.storageGiB===0,'infrastructure_storage_not_supported');
    const binding=projectApps[w.projectId];
    requireThat(binding?.isolatedNetwork===true&&typeof binding.app==='string'&&/^[a-z][a-z0-9-]{2,62}$/.test(binding.app),'infrastructure_project_host_unconfigured');
    const detail=await call('GET','/v1/apps/'+binding.app);
    requireThat(detail?.organization?.slug===organization,'infrastructure_account_mismatch');return binding.app;
  };
  function observe(w,m,appName){
    if(!m)return {operationId:w.id,accountId,providerResourceId:w.providerResourceId??null,ready:false,terminal:false,outcome:'unknown'};
    requireThat(m.name===shortId(w)&&m.config?.metadata?.['claus.operation']===w.id&&m.config?.metadata?.['claus.project']===w.projectId&&m.config.image===w.manifest.image,'infrastructure_resource_mismatch');
    const serves=['http','model'].includes(w.manifest.mode);
    const healthy=!serves||Array.isArray(m.checks)&&m.checks.some(c=>c.name==='readiness'&&c.status==='passing');
    return {operationId:w.id,accountId,providerResourceId:m.id,ready:m.state==='started'&&healthy,terminal:m.state==='destroyed',state:m.state,endpoint:serves&&m.state==='started'&&healthy?'https://'+appName+'.fly.dev':null};
  }
  async function find(w,appName){
    const list=await call('GET','/v1/apps/'+appName+'/machines?include_deleted=true&metadata.claus.operation='+encodeURIComponent(w.id));
    requireThat(Array.isArray(list),'infrastructure_response_invalid');const matched=list.filter(m=>m.config?.metadata?.['claus.operation']===w.id);
    requireThat(matched.length<=1,'infrastructure_duplicate_resource');return matched[0]??null;
  }
  async function withReceipt(w,o){if(o.terminal&&typeof readReceipt==='function'){const receipt=await readReceipt(w,o);if(receipt)o.receipt=receipt;}return o;}
  return {...costing({quote,verifyRelease,verifyReceipt}),
    async create(w){
      const appName=await app(w),found=await find(w,appName);if(found)return observe(w,found,appName);
      requireThat(w.leaseUntil>Date.now(),'infrastructure_lease_expired');
      const m=w.manifest,serves=['http','model'].includes(m.mode);
      const config={image:m.image,init:m.command.length?{exec:m.command}:{},guest:{cpu_kind:'shared',cpus:m.cpu,memory_mb:m.memoryMiB},restart:{policy:m.mode==='job'?'no':'on-failure',max_retries:3},metadata:{'claus.operation':w.id,'claus.project':w.projectId},env:{CLAUS_PROJECT_ID:w.projectId,CLAUS_RESOURCE_ID:w.id},auto_destroy:false};
      if(serves){config.services=[{protocol:'tcp',internal_port:m.port,ports:[{port:443,handlers:['tls','http']}],autostart:false}];config.checks={readiness:{type:'http',port:m.port,method:'GET',path:m.healthPath,interval:'15s',timeout:'5s'}};}
      return observe(w,await call('POST','/v1/apps/'+appName+'/machines',{name:shortId(w),region:m.region,config}),appName);
    },
    async inspect(w){const appName=await app(w);return withReceipt(w,observe(w,await find(w,appName),appName));},
    async stop(w){
      const appName=await app(w),found=await find(w,appName);const state=observe(w,found,appName);if(!found||state.terminal)return withReceipt(w,state);
      if(w.desired==='stopped'&&w.leaseUntil>Date.now()){
        if(!['stopped','stopping','suspended'].includes(found.state))await call('POST','/v1/apps/'+appName+'/machines/'+encodeURIComponent(found.id)+'/stop',{signal:'SIGTERM',timeout:'10s'});
      }else await call('DELETE','/v1/apps/'+appName+'/machines/'+encodeURIComponent(found.id)+'?force=true');
      return withReceipt(w,observe(w,await find(w,appName),appName));
    },
    async logs(w){const appName=await app(w),m=await find(w,appName);observe(w,m,appName);return JSON.stringify({providerState:m?.state??'unknown',events:m?.events??[]}).slice(0,16000);}
  };
}

export function createRunpodInfrastructure({token,accountId,request=fetch,quote,verifyRelease,verifyReceipt,readReceipt}){
  text(accountId);const call=client('https://api.runpod.io',token,request);
  const validate=w=>{check(w,'runpod',accountId);requireThat(w.manifest.gpu!==null&&w.manifest.storageGiB===0,'infrastructure_gpu_configuration_unsupported');};
  function observe(w,p){
    if(!p)return {operationId:w.id,accountId,providerResourceId:w.providerResourceId??null,ready:false,terminal:false,outcome:'unknown'};
    requireThat(p.name===shortId(w)&&p.env?.CLAUS_RESOURCE_ID===w.id&&p.env?.CLAUS_PROJECT_ID===w.projectId&&p.image===w.manifest.image,'infrastructure_resource_mismatch');
    return {operationId:w.id,accountId,providerResourceId:p.id,ready:p.status==='RUNNING',terminal:p.status==='TERMINATED',state:p.status,endpoint:null};
  }
  async function find(w){
    if(w.providerResourceId){const p=await call('GET','/v2/pods/'+encodeURIComponent(w.providerResourceId),undefined,{notFound:true});if(p)return p;}
    let cursor=null,matched=null;
    for(let page=0;page<10;page++){
      const v=await call('GET','/v2/pods?limit=100'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
      requireThat(Array.isArray(v?.pods)&&v.pagination,'infrastructure_response_invalid');
      for(const p of v.pods)if(p.env?.CLAUS_RESOURCE_ID===w.id){requireThat(!matched,'infrastructure_duplicate_resource');matched=p;}
      if(v.pagination.hasNextPage===false)return matched;
      requireThat(typeof v.pagination.nextCursor==='string'&&v.pagination.nextCursor!==cursor,'infrastructure_cursor_invalid');cursor=v.pagination.nextCursor;
    }
    throw Object.assign(Error('infrastructure_inventory_incomplete'),{code:'infrastructure_inventory_incomplete'});
  }
  async function withReceipt(w,o){if(typeof readReceipt==='function'){const receipt=await readReceipt(w,o);if(receipt?.final===true){o.terminal=true;o.receipt=receipt;}}return o;}
  return {...costing({quote,verifyRelease,verifyReceipt}),
    async catalog(){const v=await call('GET','/v2/catalog/gpus?include=AVAILABILITY&product=POD&cloud=SECURE');requireThat(Array.isArray(v.gpus),'infrastructure_response_invalid');return v;},
    async create(w){
      validate(w);const found=await find(w);if(found)return observe(w,found);requireThat(w.leaseUntil>Date.now(),'infrastructure_lease_expired');
      const m=w.manifest;const body={name:shortId(w),image:m.image,cloud:'SECURE',gpu:{id:m.gpu,count:m.gpuCount??1,minVcpuCountPerGpu:Math.ceil(m.cpu/(m.gpuCount??1)),minRamPerGpu:Math.ceil(m.memoryMiB/1024/(m.gpuCount??1))},dataCenterIds:[m.region],disk:20,ports:[],env:{CLAUS_PROJECT_ID:w.projectId,CLAUS_RESOURCE_ID:w.id},globalNetworking:false,startSsh:false,startJupyter:false};
      requireThat(m.command.length===0,'runpod_command_must_be_built_into_image');
      // Model serving ingress is provisioned separately; raw provider ports are
      // never exposed as an authenticated Claus inference endpoint.
      const p=await call('POST','/v2/pods',body);return observe(w,p);
    },
    async inspect(w){validate(w);return withReceipt(w,observe(w,await find(w)));},
    async stop(w){validate(w);const p=await find(w),o=observe(w,p);if(!p||o.terminal)return withReceipt(w,o);
      if(w.desired==='stopped'&&w.leaseUntil>Date.now()){
        if(p.actions?.includes('stop'))await call('POST','/v2/pods/'+encodeURIComponent(p.id)+'/action',{action:'stop'});
      }else await call('DELETE','/v2/pods/'+encodeURIComponent(p.id));
      return withReceipt(w,observe(w,await find(w)));
    },
    async logs(w){validate(w);const p=await find(w);observe(w,p);requireThat(p,'infrastructure_resource_unknown');return call('GET','/v2/pods/'+encodeURIComponent(p.id)+'/logs?tail=100',undefined,{logs:true});},
    async billing(w){validate(w);const p=await find(w);observe(w,p);const id=p?.id??w.providerResourceId;requireThat(id,'infrastructure_resource_unknown');return call('GET','/v2/billing/pods?podId='+encodeURIComponent(id)+'&startTime='+encodeURIComponent(new Date(w.createdAt).toISOString())+'&endTime='+encodeURIComponent(new Date().toISOString())+'&bucketSize=hour');}
  };
}
