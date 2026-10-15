export async function operatingResources({request=fetch,secret=process.env.INFERENCE_SECRET}:any={}){
 if(!secret)return {state:'unavailable',reason:'operating_resources_not_configured'};
 try{
  const response=await request('https://claus-ecosystem-payments.vercel.app/api/resources',{method:'GET',redirect:'error',headers:{authorization:'Bearer '+secret,accept:'application/json'},signal:AbortSignal.timeout(6000)});
  if(!response.ok){await response.body?.cancel();return {state:'unavailable',reason:'operating_resources_unavailable',httpStatus:response.status};}
  const reader=response.body?.getReader();if(!reader)throw Error('empty');let size=0;const parts:Uint8Array[]=[];
  try{for(;;){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>20000){await reader.cancel();throw Error('too_large');}parts.push(p.value);}}finally{reader.releaseLock();}
  const value=JSON.parse(Buffer.concat(parts).toString());
  if(value.version!==1||value.automaticFundingEnabled!==false||!value.budget||!value.provider||!value.onchain||!value.funding)throw Error('invalid');
  return {state:'available',...value,authority:'Read-only operating resources and a non-executable funding proposal; not permission to transfer, refill or raise a budget.'};
 }catch{return {state:'unavailable',reason:'operating_resources_unavailable'};}
}
