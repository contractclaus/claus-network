import {retryTime} from './providers.mjs';
import {createHash} from 'node:crypto';
const fail=c=>{throw Error('resource_volume_'+c);};
const providerId=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
export function volumeProvider({request=fetch,token=()=>process.env.CLAUS_RUNPOD_API_KEY,now=Date.now}={}){
 let cachedPrice;
 const storageType=v=>{if(!['STANDARD','HIGH_PERFORMANCE'].includes(v))fail('type_invalid');return v;};
 function highPerformancePrice(region){
  let p;try{p=JSON.parse(process.env.RUNPOD_HIGH_PERFORMANCE_PRICE_JSON??'null');}catch{fail('high_performance_price_unavailable');}
  if(!p||p.type!=='HIGH_PERFORMANCE'||!Array.isArray(p.regions)||region&&!p.regions.includes(region)||!/^\d+$/.test(p.maximumMicroUsdPerGbMonth??'')||BigInt(p.maximumMicroUsdPerGbMonth)<=0n||!Number.isFinite(Date.parse(p.observedAt))||Date.parse(p.observedAt)>now()||!Number.isFinite(Date.parse(p.validUntil))||Date.parse(p.validUntil)<=now()||Date.parse(p.validUntil)-Date.parse(p.observedAt)>31*86400000)fail('high_performance_price_unavailable');
  return {...p,basis:'Dated provider-console rate, limited to the observed regions and validity period; actual invoice is reconciled separately'};
 }
 async function call(path,method='GET',body){
  if(!token())fail('not_connected');
  const r=await request('https://api.runpod.io/v2'+path,{method,headers:{authorization:'Bearer '+token(),accept:'application/json',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(18000)});
  if(!r.ok){await r.body?.cancel();const e=Error('resource_volume_provider_'+r.status);e.status=r.status;e.retryAt=retryTime(r.headers.get('retry-after'))??now()+30000;throw e;}
  if(r.status===204)return null;
  const reader=r.body?.getReader();if(!reader)fail('response_missing');const parts=[];let size=0;
  try{for(;;){const x=await reader.read();if(x.done)break;size+=x.value.length;if(size>2000000)fail('response_too_large');parts.push(x.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
 }
 const validate=v=>{if(!providerId(v?.id)||typeof v.name!=='string'||!Number.isSafeInteger(v.size)||v.size<10||v.size>4096||!providerId(v.dataCenter)||!['STANDARD','HIGH_PERFORMANCE'].includes(v.type))fail('provider_shape_invalid');return {id:v.id,name:v.name,size:v.size,dataCenter:v.dataCenter,type:v.type};};
 async function page(path,key,cursor){
  if(cursor!==undefined&&cursor!==null&&(typeof cursor!=='string'||cursor.length>4000))fail('cursor_invalid');
  const v=await call(path+'?limit=1000'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
  if(!Array.isArray(v[key])||!v.pagination||typeof v.pagination.hasNextPage!=='boolean')fail('provider_shape_invalid');
  if(v.pagination.hasNextPage&&!v.pagination.nextCursor)fail('provider_shape_invalid');
  return {items:v[key],nextCursor:v.pagination.hasNextPage?v.pagination.nextCursor:null};
 }
 return {
  configured:()=>!!token(),
  async pricing(type='STANDARD',region){
   storageType(type);if(type==='HIGH_PERFORMANCE')return highPerformancePrice(region);
   if(cachedPrice&&now()-Date.parse(cachedPrice.observedAt)<600000)return cachedPrice;
   const source='https://docs.runpod.io/storage/network-volumes.md',r=await request(source,{redirect:'error',signal:AbortSignal.timeout(15000)});
   if(!r.ok)fail('price_unavailable');const reader=r.body?.getReader();if(!reader)fail('price_unavailable');let size=0;const parts=[];
   try{for(;;){const x=await reader.read();if(x.done)break;size+=x.value.length;if(size>128000)fail('price_response_invalid');parts.push(x.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
   const raw=Buffer.concat(parts).toString('utf8'),plain=raw.replaceAll('*','').replaceAll('\\','');
   const price=/Standard storage:[\s\S]{0,300}?First 1 TB:\s*\$([0-9.]+)\/GB\/month[\s\S]{0,100}?Beyond 1 TB:\s*\$([0-9.]+)\/GB\/month/.exec(plain);
   if(!price||price.slice(1).some(v=>!Number.isFinite(Number(v))||Number(v)<=0||Number(v)>1000))fail('price_format_changed');
   cachedPrice={type:'STANDARD',maximumMicroUsdPerGbMonth:String(Math.ceil(Math.max(...price.slice(1).map(Number))*1000000)),source,sourceHash:createHash('sha256').update(raw).digest('hex'),observedAt:new Date(now()).toISOString(),basis:'Higher of both current standard tiers, reserved for all capacity; actual invoice remains separate'};return cachedPrice;
  },
  async catalog(type='STANDARD'){storageType(type);const v=await call('/catalog/datacenters?networkVolumeTypes='+type);if(!Array.isArray(v.dataCenters))fail('provider_shape_invalid');return {regions:v.dataCenters.filter(x=>providerId(x.id)&&x.networkVolumeTypes?.includes(type)).map(x=>({id:x.id,name:x.name,region:x.region})),observedAt:new Date(now()).toISOString()};},
  async read(id){if(!providerId(id))fail('provider_id_invalid');try{return validate(await call('/network-volumes/'+encodeURIComponent(id)));}catch(e){if(e.status===404)return null;throw e;}},
  async find(name,cursor=null){const p=await page('/network-volumes','networkVolumes',cursor);return {items:p.items.filter(v=>v.name===name).map(validate),nextCursor:p.nextCursor};},
  async create(v){return validate(await call('/network-volumes','POST',{name:v.name,size:v.sizeGb,dataCenter:v.region,type:storageType(v.volumeType??'STANDARD')}));},
  async resize(id,sizeGb){if(!providerId(id))fail('provider_id_invalid');return validate(await call('/network-volumes/'+encodeURIComponent(id),'PATCH',{size:sizeGb}));},
  async remove(id){if(!providerId(id))fail('provider_id_invalid');try{await call('/network-volumes/'+encodeURIComponent(id),'DELETE');}catch(e){if(e.status!==404)throw e;}return {removed:await this.read(id)===null};},
  async attachments(id,cursor=null){if(!providerId(id))fail('provider_id_invalid');const p=await page('/pods','pods',cursor);return {items:p.items.filter(v=>v.status!=='TERMINATED'&&v.mounts?.network?.some(m=>m.volumeId===id)).map(v=>({id:v.id,name:v.name,status:v.status})),nextCursor:p.nextCursor};},
  async cost(id,from){
   if(!providerId(id)||!Number.isFinite(Date.parse(from)))fail('billing_input_invalid');
   const v=await call('/billing/network-volumes?networkVolumeId='+encodeURIComponent(id)+'&startTime='+encodeURIComponent(from)+'&endTime='+encodeURIComponent(new Date(now()).toISOString())+'&bucketSize=day');
   const amount=v.metadata?.totals?.totalAmount;
   if(v.metadata?.query?.networkVolumeId!==id||!Array.isArray(v.records)||v.records.some(r=>r.networkVolumeId!==id)||typeof amount!=='number'||!Number.isFinite(amount)||amount<0)fail('billing_scope_invalid');
   return {providerResourceId:id,observedMicroUsd:String(Math.ceil(amount*1000000)),observedAt:new Date(now()).toISOString(),final:false,meaning:'Provider history may lag. Top-ups are separate funding events and must not be counted again as consumption.'};
  }
 };
}
