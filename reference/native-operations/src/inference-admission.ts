import {confirmedNoExecution} from './negative-receipt.js';
// A rejection is not proof of nonpayment. Only this known payer's durable
// negative receipt fences the original ID against delayed admission.
export async function fencedInferenceRejection(response:Response,id:string,origin:string,secret:string,request:typeof fetch=fetch,now=Date.now) {
  if(origin!=='https://claus-ecosystem-payments.vercel.app'||![409,503].includes(response.status))return null;
  let body:any;
  try{body=await response.json();}catch{body=null;}
  try{
    const status=await request(`${origin}/api/requests/${encodeURIComponent(id)}`,{headers:{Authorization:`Bearer ${secret}`},redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!await confirmedNoExecution(status,id,origin))return null;
  }catch{return null;}
  const seconds=Number.isInteger(body?.retryAfterSeconds)&&body.retryAfterSeconds>=5&&body.retryAfterSeconds<=900?body.retryAfterSeconds:60;
  const reason=typeof body?.error==='string'&&/^(capital_[a-z_]{1,64}|quoted_reservation_unavailable|request_already_reserved)$/.test(body.error)?body.error:'request_not_reserved';
  return {reason:`inference_${reason}`,retryAt:new Date(now()+seconds*1000).toISOString()};
}
