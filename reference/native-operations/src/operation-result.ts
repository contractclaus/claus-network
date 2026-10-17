const incomplete=new Set(['running','preparing','deploying','waiting','blocked','stopped','cancelled','canceled','in_progress','pending','uncertain','failed','queued','unavailable','unknown','requires_reconciliation','reverted','rejected','postcondition_failed']);
// The synchronous status reader has finished even though the server it read
// must keep running. This proves only that observation, never settled costs or
// a completed create/renew action. Keep the exception to this exact envelope.
function runningResourceObserved(value:any){
 const resource=value?.result;
 return value?.operation==='resource_status'&&typeof value.observedAt==='string'&&Number.isFinite(Date.parse(value.observedAt))&&
  resource?.state==='running'&&resource.desired==='running'&&resource.error===null&&resource.requiresReconciliation===false&&resource.renewalPending===false&&
  /^sha256:[a-f0-9]{64}$/.test(resource.id??'')&&typeof resource.projectId==='string'&&resource.projectId.startsWith('prj_')&&
  typeof resource.providerResourceId==='string'&&resource.providerResourceId.length>0;
}
/** Checks the current response envelopes, not historical records inside a status. */
export function operationSucceeded(value:any){
 if(!value||typeof value!=='object')return false;
 const resourceObservation=runningResourceObserved(value);
 for(let result=value,depth=0;result&&typeof result==='object';depth++,result=result.result){
  if(depth>=8||Array.isArray(result)||result.error||result.observationError||result.success===false||result.ok===false||incomplete.has(result.status)||(incomplete.has(result.state)&&!(depth===1&&resourceObservation&&result.state==='running'))||incomplete.has(result.outcome)||
   (typeof result.exitCode==='number'&&result.exitCode!==0)||
   (result.httpStatus!==undefined&&(!Number.isInteger(result.httpStatus)||result.httpStatus<200||result.httpStatus>=300)))return false;
 }
 return true;
}
