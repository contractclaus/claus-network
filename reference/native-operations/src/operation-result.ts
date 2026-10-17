const incomplete=new Set(['running','preparing','deploying','waiting','blocked','stopped','cancelled','canceled','in_progress','pending','uncertain','failed','queued','unavailable','unknown','requires_reconciliation','reverted','rejected','postcondition_failed']);
/** Checks the current response envelopes, not historical records inside a status. */
export function operationSucceeded(value:any){
 if(!value||typeof value!=='object')return false;
 for(let result=value,depth=0;result&&typeof result==='object';depth++,result=result.result){
  if(depth>=8||Array.isArray(result)||result.error||result.observationError||result.success===false||result.ok===false||incomplete.has(result.status)||incomplete.has(result.state)||incomplete.has(result.outcome)||
   (typeof result.exitCode==='number'&&result.exitCode!==0)||
   (result.httpStatus!==undefined&&(!Number.isInteger(result.httpStatus)||result.httpStatus<200||result.httpStatus>=300)))return false;
 }
 return true;
}
