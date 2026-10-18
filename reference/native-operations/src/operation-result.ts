const incomplete=new Set(['running','preparing','deploying','waiting','blocked','stopped','cancelled','canceled','in_progress','pending','uncertain','failed','queued','unavailable','unknown','requires_reconciliation','reverted','rejected','postcondition_failed']);
// Saving a work checkpoint can succeed while its external dependency is pending.
// This receipt never certifies the underlying task and is excluded from work evidence.
export function networkCheckpointSaved(value:any,input:any){
 return input?.action==='update'&&typeof input.id==='string'&&/^nw_[A-Za-z0-9_-]+$/.test(input.id)&&
  Number.isSafeInteger(input.expectedRevision)&&input.expectedRevision>=1&&
  ['ready','working','waiting','completed','cancelled'].includes(input.status)&&
  value?.id===input.id&&value.revision===input.expectedRevision+1&&value.status===input.status&&
  !value.error&&!value.observationError&&value.success!==false&&value.ok!==false&&
  Number.isFinite(Date.parse(value.updated_at))&&Number.isFinite(Date.parse(value.next_at))&&
  typeof value.next_step==='string'&&typeof value.summary==='string'&&Array.isArray(value.evidence)&&
  (value.status!=='waiting'||typeof value.blocker==='string'&&value.blocker.trim().length>0);
}
// A dated status read is complete even if it observes a stopped predecessor.
// This proves the observation only, never service health, settled cost or a write.
export function resourceStatusObserved(value:any){
 const resource=value?.result;
 return value?.operation==='resource_status'&&typeof value.observedAt==='string'&&Number.isFinite(Date.parse(value.observedAt))&&
  ((resource?.state==='running'&&resource.desired==='running')||(resource?.state==='stopped'&&resource.terminal===true&&['running','stopped'].includes(resource.desired)))&&
  resource.error===null&&resource.requiresReconciliation===false&&resource.renewalPending===false&&
  /^sha256:[a-f0-9]{64}$/.test(resource.id??'')&&typeof resource.projectId==='string'&&resource.projectId.startsWith('prj_')&&
  typeof resource.providerResourceId==='string'&&resource.providerResourceId.length>0;
}
/** Checks the current response envelopes, not historical records inside a status. */
export function operationSucceeded(value:any){
 if(!value||typeof value!=='object')return false;
 const resourceObservation=resourceStatusObserved(value);
 for(let result=value,depth=0;result&&typeof result==='object';depth++,result=result.result){
  if(depth>=8||Array.isArray(result)||result.error||result.observationError||result.success===false||result.ok===false||incomplete.has(result.status)||(incomplete.has(result.state)&&!(depth===1&&resourceObservation))||incomplete.has(result.outcome)||
   (typeof result.exitCode==='number'&&result.exitCode!==0)||
   (result.httpStatus!==undefined&&(!Number.isInteger(result.httpStatus)||result.httpStatus<200||result.httpStatus>=300)))return false;
 }
 return true;
}
