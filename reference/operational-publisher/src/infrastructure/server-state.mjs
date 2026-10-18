import {createHash} from 'node:crypto';

const watchImage='claus-network-api.vercel.app/claus/335f1c2f4eb9bb8f7386d85cc9c65c7c24a76e8fa067212c9a3b552c6b348a79@sha256:72b4f46564e349d915c9529134a6960887cfcf1f138c575843cff90d0aca9649';
const searchImage='claus-network-api.vercel.app/claus/5c7053e9e54111f7bba640d7af191ebc5982e2a50aecbb48adf9f3bcff35e51e@sha256:65ac06800a6e5b0ab25fc051b9273db0d6e8ec19ad7622fae65e13fe13c7fed0';
const iso=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v)&&Number.isFinite(Date.parse(v));
const fail=()=>{throw Error('resource_server_state_invalid');};
const sha=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function serverStatePolicy(work){
 if(work?.manifest?.image===watchImage)return {kind:'watch-history',description:'Public endpoint observations are archived off the server. Source RAM holds at most 24 hours.'};
 if(work?.manifest?.image===searchImage)return {kind:'stateless-search',description:'Reviewed immutable model image and published source; no application filesystem writes. Query memory is transient and is not archived.'};
 return {kind:'unclassified',description:'No application snapshot adapter for this image. Inspect its volumes, checkpoints and data export before retirement.'};
}
async function boundedJson(response){
 if(!response.ok||!response.body)throw Error('resource_server_state_source_unavailable');
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>524288)fail();chunks.push(value);}}finally{await reader.cancel();}
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function observation(v,now){
 if(!v||!iso(v.observedAt)||Date.parse(v.observedAt)>now+60000||typeof v.healthy!=='boolean'||!Array.isArray(v.checks)||v.checks.length!==3)fail();
 const names=new Set();
 const checks=v.checks.map(c=>{
  if(!c||!['network-api','network-map','network-operations'].includes(c.name)||names.has(c.name)||!Number.isInteger(c.status)||c.status<0||c.status>599||typeof c.latencyMs!=='number'||!Number.isFinite(c.latencyMs)||c.latencyMs<0||typeof c.ok!=='boolean'||c.error!==undefined&&(typeof c.error!=='string'||c.error.length>2000))fail();
  names.add(c.name);return {name:c.name,status:c.status,latencyMs:c.latencyMs,ok:c.ok,...(c.error?{error:c.error}:{})};
 });
 return {observedAt:v.observedAt,checks,healthy:v.healthy};
}
export function serverState({store,request=fetch,now=Date.now}){
 async function capture(record,{force=false}={}){
  const work=record.work,policy=serverStatePolicy(work);
  if(policy.kind!=='watch-history')return {...policy,state:policy.kind==='stateless-search'?'immutable-source':'unclassified'};
  const prior=await store.get('server-state',work.id),at=new Date(now()).toISOString();
  if(!force&&prior?.lastSuccessfulAt&&Date.parse(prior.lastSuccessfulAt)>now()-300000)return prior;
  try{
   if(record.providerConfig?.provider!=='runpod'||!/^[a-z0-9]{8,40}$/.test(record.providerResourceId??'')||work.manifest.port!==8080)fail();
   const origin='https://'+record.providerResourceId+'-8080.proxy.runpod.net';
   if(record.endpoint&&record.endpoint!==origin)fail();
   const collected=[],seen=new Set(),signal=AbortSignal.timeout(28000);let before=null,complete=false;
   for(let page=0;page<6;page++){
    const response=await request(origin+'/v1/history?limit=240'+(before?'&before='+encodeURIComponent(before):''),{method:'GET',redirect:'error',signal});
    const body=await boundedJson(response);
    if(!Array.isArray(body.observations)||body.observations.length>240)fail();
    const rows=body.observations.map(v=>observation(v,now()));
    for(let i=0;i<rows.length;i++){
     if(i&&Date.parse(rows[i].observedAt)<=Date.parse(rows[i-1].observedAt)||before&&Date.parse(rows[i].observedAt)>=Date.parse(before)||seen.has(rows[i].observedAt))fail();
     seen.add(rows[i].observedAt);
    }
    collected.push(...rows);
    if(!body.nextBefore||prior?.latestObservationAt&&rows.some(r=>Date.parse(r.observedAt)<=Date.parse(prior.latestObservationAt))){complete=true;break;}
    if(!iso(body.nextBefore)||!rows.length||body.nextBefore!==rows[0].observedAt)fail();before=body.nextBefore;
   }
   if(!complete)fail();
   const rows=collected.map(v=>({id:work.id+':'+v.observedAt,observation:v,resourceId:work.id,projectId:work.projectId,image:work.manifest.image,providerResourceId:record.providerResourceId,capturedAt:at,sha256:sha(v)}));
   const saved=await store.serverObservationsSave(work.id,rows,{...policy,state:'saved',resourceId:work.id,projectId:work.projectId,image:work.manifest.image,lastAttemptAt:at,lastSuccessfulAt:at,lastError:null,source:origin+'/v1/history',cadenceSeconds:300,coverage:'Available observations only; no reconstruction of history lost before the first archive. Capture is attempted before stop/delete. A dead server can lose observations since the last successful capture.'});
   return saved;
  }catch(e){
   return store.serverStateSave(work.id,{...policy,state:'degraded',resourceId:work.id,lastAttemptAt:at,lastError:/^resource_server_state_[a-z_]+$/.test(e.message)?e.message:'resource_server_state_source_unavailable'});
  }
 }
 async function read(input){
  if(!/^sha256:[a-f0-9]{64}$/.test(input.resourceId??'')||input.before!==undefined&&!iso(input.before)||input.limit!==undefined&&(!Number.isInteger(input.limit)||input.limit<1||input.limit>240)||input.refresh!==undefined&&typeof input.refresh!=='boolean')fail();
  const record=await store.infrastructureRecord(input.resourceId);if(!record)fail();
  const policy=serverStatePolicy(record.work);
  const state=input.refresh?await capture(record,{force:true}):await store.get('server-state',input.resourceId);
  const page=await store.serverObservations(input.resourceId,input.before??null,input.limit??60);
  return {resourceId:input.resourceId,projectId:record.work.projectId,policy,state,history:page,instructionAuthority:false,providerChanges:0,meaning:'Durable observations in the protected custody database, outside the original server lifecycle. Included in the existing database-backup scope; this read does not prove a later offsite backup has run.'};
 }
 return {capture,read};
}
