import {digest} from './store.mjs';
const url='https://api.surplusintelligence.ai/v1/models';
const fail=c=>{throw Error('resource_model_'+c);};
const strings=v=>Array.isArray(v)?[...new Set(v.filter(s=>typeof s==='string'&&s.length<120))].sort():[];
const number=v=>Number.isSafeInteger(v)&&v>0?v:null;
const price=v=>typeof v==='string'&&/^\d+(?:\.\d{1,20})?$/.test(v)&&Number.isFinite(Number(v))?v:null;
export function normalizeModels(value){
 if(!Array.isArray(value?.data)||!value.data.length||value.data.length>5000)fail('catalog_invalid');
 const out=value.data.map(x=>{
  if(typeof x?.id!=='string'||!x.id||x.id.length>160||typeof x.provider!=='string'||x.provider.length>100)fail('catalog_invalid');
  return {id:x.id,provider:x.provider,contextTokens:number(x.context_length),maximumOutputTokens:number(x.top_provider?.max_completion_tokens),inputModalities:strings(x.architecture?.input_modalities),outputModalities:strings(x.architecture?.output_modalities),features:strings(x.supported_features),parameters:strings(x.supported_parameters),pricing:{unit:'USD per token',input:price(x.pricing?.prompt),output:price(x.pricing?.completion),cacheRead:price(x.pricing?.input_cache_read),cacheWrite:price(x.pricing?.input_cache_write)}};
 }).sort((a,b)=>a.id.localeCompare(b.id,'en'));
 if(new Set(out.map(x=>x.id)).size!==out.length)fail('catalog_duplicates');return out;
}
export function modelCatalog({store,request=fetch,now=Date.now}){
 async function refresh(){
  const response=await request(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok)fail('catalog_unavailable');
  const reader=response.body.getReader(),parts=[];let bytes=0;
  try{for(;;){const p=await reader.read();if(p.done)break;bytes+=p.value.length;if(bytes>5000000)fail('catalog_size');parts.push(p.value);}}finally{try{await reader.cancel();}catch{}}
  let value;try{value=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{fail('catalog_invalid');}
  const models=normalizeModels(value),version=digest(models),at=new Date(now()).toISOString(),prior=await store.get('model-catalog','surplus');
  const record={provider:'surplus',version,source:url,observedAt:at,validUntil:new Date(now()+6*3600000).toISOString(),models,instructionAuthority:false};
  await store.put('model-catalog-version',version,{...record,firstObservedAt:at});
  const next={...record,revision:(prior?.revision??0)+1};
  if(prior){try{await store.change('model-catalog','surplus',prior.revision,next);}catch(error){const current=await store.get('model-catalog','surplus');if(!current||Date.parse(current.observedAt)<now()-60000)throw error;return current;}}
  else {const r=await store.put('model-catalog','surplus',next);return r.value;}
  return next;
 }
 async function current(force=false){return force?refresh():(await store.get('model-catalog','surplus'))??refresh();}
 return {refresh,current,async listed(model,version){const c=await current();if(c.version!==version||Date.parse(c.validUntil)<=now())fail('catalog_stale');const m=c.models.find(x=>x.id===model);if(!m)fail('model_unlisted');return m;},async read(input){
  if(input.refresh!==undefined&&typeof input.refresh!=='boolean'||input.query!==undefined&&(typeof input.query!=='string'||input.query.length>160)||input.offset!==undefined&&(!Number.isSafeInteger(input.offset)||input.offset<0)||input.version!==undefined&&!/^[a-f0-9]{64}$/.test(input.version))fail('catalog_input');
  const c=input.version?await store.get('model-catalog-version',input.version):await current(input.refresh===true);if(!c)fail('catalog_missing');
  const models=c.models.filter(x=>!input.query||(x.id+' '+x.provider+' '+x.features.join(' ')).toLowerCase().includes(input.query.toLowerCase())),offset=input.offset??0;
  return {provider:c.provider,version:c.version,source:c.source,observedAt:c.observedAt,validUntil:c.validUntil,stale:Date.parse(c.validUntil)<=now(),total:models.length,models:models.slice(offset,offset+25),offset,nextOffset:offset+25<models.length?offset+25:null,meaning:'Dated provider listings and advertised prices, not a successful model call or spending authority. Only explicit active routes are callable.',instructionAuthority:false};
 }};
}
