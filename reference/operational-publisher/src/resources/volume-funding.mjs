import {createHmac,timingSafeEqual} from 'node:crypto';
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
export function volumeFunding({request=fetch,secret=()=>process.env.CLAUS_OCI_NETWORK_SECRET,now=Date.now}={}){
 return async(operation,id,prepared)=>{
  if(!secret()||secret().length<24)throw Error('resource_volume_funding_unavailable');
  const input={operation,id,resourceId:prepared.id??prepared.resource.id,maximum:prepared.maximum,fundedUntil:prepared.fundedUntil??prepared.resource.fundedUntil},raw=JSON.stringify(input),timestamp=String(now());
  const proof=createHmac('sha256',secret()).update(timestamp+'.'+raw).digest('hex');
  const r=await request('https://claus-network-api.vercel.app/internal/infrastructure/volume-funding',{method:'POST',headers:{'content-type':'application/json','x-claus-timestamp':timestamp,'x-claus-volume-proof':proof},body:raw,redirect:'error',signal:AbortSignal.timeout(20000)});
  const v=await r.json();
  if(!r.ok)throw Error(v.error==='funding_insufficient'?'resource_volume_provider_funding_insufficient':'resource_volume_funding_unavailable');
  const expected=createHmac('sha256',secret()).update(canonical({input,result:v.result})).digest('hex');
  if(!/^[a-f0-9]{64}$/.test(v.proof??'')||!timingSafeEqual(Buffer.from(v.proof,'hex'),Buffer.from(expected,'hex'))||v.result?.id!==id||v.result?.maximum!==prepared.maximum)throw Error('resource_volume_funding_proof_invalid');
  return v.result;
 };
}
