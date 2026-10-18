import {createHash} from 'node:crypto';
import {neon} from '@neondatabase/serverless';

export const independentInferenceConfigured=(env=process.env)=>Boolean(env.CONTINUITY_URL&&env.CONTINUITY_SECRET&&env.CONTINUITY_INFERENCE_ACTIVATED_AT);
export async function independentInferenceOriginal(id:string,env=process.env){
 if(!env.CONTINUITY_URL)return false;
 const rows=await neon(env.DATABASE_URL!)`SELECT route FROM claus_inference_routes WHERE id=${id}`;
 return rows[0]?.route==='continuity-v1';
}
const headers=(env=process.env)=>({authorization:`Bearer ${env.CONTINUITY_SECRET}`,'content-type':'application/json'});
// Decide before any paid POST. Healthy primary calls keep their existing path,
// so losing this optional controller cannot interrupt the primary provider.
export async function independentNeeded(id:string,maximum:string,fetcher:typeof fetch=fetch,env=process.env,origin=env.INFERENCE_URL,secret=env.INFERENCE_SECRET){
 if(!independentInferenceConfigured(env))return false;
 try{
  const r=await fetcher(`${origin}/api/admission/${encodeURIComponent(id)}?maximumMicroUsdc=${maximum}`,{headers:{authorization:`Bearer ${secret}`},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(r.ok){const b=await r.json();if(b.id===id&&b.maximumMicroUsdc===maximum&&b.ready===true)return false;}
 }catch{/* No paid request has been sent. The original fallback ID is retained below. */}
 return true;
}
export async function independentStatus(id:string,fetcher:typeof fetch=fetch,env=process.env){
 const response=await fetcher(`${env.CONTINUITY_URL}/v1/inference/status/${encodeURIComponent(id)}`,{headers:headers(env),redirect:'error',signal:AbortSignal.timeout(20000)});
 if(!response.ok)return {id,status:'unknown'};
 const result=await response.json();
 if(result?.id!==id)throw Error('independent_original_mismatch');
 return result;
}
export function validIndependentModel(body:any,requestedModel:string,id:string,env=process.env):boolean{
 const route=body?.routing;
 return body?.model===requestedModel||body?.model===env.CONTINUITY_MODEL&&route?.route==='independent'&&route?.requestedModel===requestedModel&&route?.actualModel===body.model&&route?.originalRequestId===id&&route?.context?.visibleContextPreserved===true&&route?.context?.truncated===false;
}
export function independentBilling(id:string,ceiling:string,body:any){
 const r=body?.receipt,amount=r?.authorizedMicroUsd;
 if(r?.kind!=='owned_prepaid_allowance'||r.requestId!==id||typeof r.grantId!=='string'||typeof amount!=='string'||!/^\d{1,24}$/.test(amount)||BigInt(amount)<1n||BigInt(amount)>BigInt(ceiling))return undefined;
 return {requestId:id,amount,scheme:'upto' as const,basis:'owned_prepaid_allocation' as const};
}
export async function independentComplete(id:string,request:any,maximum:string,fetcher:typeof fetch=fetch,env=process.env,timeoutMs=650000){
 const db=neon(env.DATABASE_URL!),inputHash=createHash('sha256').update(JSON.stringify({request,maximum})).digest('hex');
 await db`INSERT INTO claus_inference_routes(id,route,input_hash) VALUES(${id},'continuity-v1',${inputHash}) ON CONFLICT DO NOTHING`;
 const [binding]=await db`SELECT route,input_hash FROM claus_inference_routes WHERE id=${id}`;
 if(binding?.route!=='continuity-v1'||binding.input_hash!==inputHash)throw Error('inference_original_route_conflict');
 const response=await fetcher(`${env.CONTINUITY_URL}/v1/inference/start`,{method:'POST',headers:headers(env),body:JSON.stringify({id,input:request,maximumMicroUsd:maximum,prefer:'independent',...(env.CONTINUITY_EFFECTS_ENABLED==='true'?{instance:env.CONTINUITY_INSTANCE,epoch:Number(env.CONTINUITY_WRITER_EPOCH)}:{})}),redirect:'error',signal:AbortSignal.timeout(45000)});
 if(!response.ok)throw Error('independent_submission_uncertain');
 const accepted=await response.json();if(accepted.id!==id||accepted.originalRetained!==true)throw Error('independent_submission_uncertain');
 const end=Date.now()+timeoutMs;
 while(Date.now()<end){
  const original=await independentStatus(id,fetcher,env);
  if(original.status==='completed'){
   const body=original.response;
   if(!body?.choices?.[0]?.message||!validIndependentModel(body,request.model,id,env))throw Error('independent_model_result_invalid');
   return body;
  }
  if(original.status==='not_dispatched')throw Error('independent_original_not_dispatched');
  if(original.status==='failed')throw Error('independent_original_failed');
  await new Promise(resolve=>setTimeout(resolve,2500));
 }
 throw Error('independent_original_requires_reconciliation');
}
export async function independentAdmission(maximum:string,fetcher:typeof fetch=fetch,env=process.env){
 try{const r=await fetcher(`${env.CONTINUITY_URL}/v1/inference/admission?maximumMicroUsd=${encodeURIComponent(maximum)}`,{headers:headers(env),redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok)return false;const b=await r.json();return b.ready===true&&b.maximumMicroUsd===maximum&&b.rail==='owned_prepaid_allowance';}catch{return false;}
}

// Effects are archived before dispatch and settled before the local success is
// acknowledged. A stale primary may settle an original, but cannot claim a new one.
export async function durableEffectClaim(id:string,kind:string,input:any,inputHash:string,fetcher:typeof fetch=fetch,env=process.env){
 if(env.CONTINUITY_EFFECTS_ENABLED!=='true')return null;
 const response=await fetcher(`${env.CONTINUITY_URL}/v1/effects/claim`,{method:'POST',headers:headers(env),body:JSON.stringify({id,kind,input,inputHash,instance:env.CONTINUITY_INSTANCE,epoch:Number(env.CONTINUITY_WRITER_EPOCH)}),redirect:'error',signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw Error('durable_effect_claim_uncertain');const result=await response.json();if(result.id!==id)throw Error('durable_effect_original_mismatch');return result;
}
export async function durableEffectSettle(id:string,token:string,state:'completed'|'failed'|'uncertain',result:any,fetcher:typeof fetch=fetch,env=process.env){
 const response=await fetcher(`${env.CONTINUITY_URL}/v1/effects/settle`,{method:'POST',headers:headers(env),body:JSON.stringify({id,token,state,result}),redirect:'error',signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw Error('durable_effect_settlement_uncertain');const value=await response.json();if(value.id!==id||value.state!==state)throw Error('durable_effect_original_mismatch');
}
