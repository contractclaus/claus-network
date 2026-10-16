// Read-only progress projection. The scheduler and original effects own timing.
export const builderTerminalStates=['ready_for_review','needs_changes','editing','blocked','untested','published'];
export function builderProgress(project:any,capacity:any,sent=false){
 const check=project.next_at==null?NaN:new Date(project.next_at).getTime();
 const nextCheckAt=Number.isFinite(check)?new Date(check).toISOString():null;
 if(sent||project.status==='reconciling')return {waitingReason:'ambiguous_effect',nextEligibleAt:null,nextCheckAt};
 if(builderTerminalStates.includes(project.status))return {waitingReason:null,nextEligibleAt:null,nextCheckAt:null};
 if(project.status==='waiting_model_quota')return {waitingReason:capacity.reason,nextEligibleAt:capacity.eligibleAt,nextCheckAt:capacity.nextCheckAt};
 return {waitingReason:project.status.startsWith('waiting_')?project.status:null,nextEligibleAt:nextCheckAt,nextCheckAt};
}
export function builderDispatchRecord(project:any,sent:boolean){
 const resuming=sent||project.effects.length>0||project.revision>0;
 return {kind:sent?'builder_reconciliation':resuming?'builder_resumed':'builder_started',
  summary:sent?'Existing build receipt check queued':resuming?'Existing build work resumed':'Build work queued',
  visibility:'private_club',
  purpose:project.purpose,operation:sent?'reconcile':resuming?'resume':'build'};
}
