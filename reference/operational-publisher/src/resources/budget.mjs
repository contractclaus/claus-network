import {digest} from './store.mjs';
export function resourceBudget({request=fetch,secret=()=>process.env.PUBLISHER_REVIEW_SECRET}={}){
 return async(operation,actionId,maximum,kind='build',sequence=0)=>{
  if(!['build','storage','volume','service'].includes(kind)||!Number.isSafeInteger(sequence)||sequence<0||!secret())throw Error('resource_budget_unavailable');
  const id='owned:sha256:'+digest(actionId)+':'+kind+':'+sequence;
  const response=await request('https://claus-ecosystem-payments.vercel.app/api/operating-budget',{method:'POST',headers:{authorization:'Bearer '+secret(),'content-type':'application/json'},body:JSON.stringify({operation,id,maximum}),redirect:'error',signal:AbortSignal.timeout(15000)});
  const value=await response.json();if(!response.ok||value.id!==id||value.maximum!==maximum)throw Error('resource_budget_unavailable');return value;
 };
}
