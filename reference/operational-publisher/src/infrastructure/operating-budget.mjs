const endpoint='https://claus-ecosystem-payments.vercel.app/api/operating-budget';
export function infrastructureBudget({request=fetch,secret=()=>process.env.PUBLISHER_REVIEW_SECRET}={}){
 return async(operation,work,extension=null)=>{
  const maximum=String(extension?.quote?.maximum??work.quote.maximum),id='infrastructure:'+work.id+':lease:'+(extension?.sequence??0);
  if(!secret())throw Error('infrastructure_budget_unavailable');
  const r=await request(endpoint,{method:'POST',redirect:'error',headers:{authorization:'Bearer '+secret(),'content-type':'application/json'},body:JSON.stringify({operation,id,maximum}),signal:AbortSignal.timeout(15000)});
  const result=await r.json();if(!r.ok||result.id!==id||result.maximum!==maximum)throw Error('infrastructure_budget_unavailable');return result;
 };
}
