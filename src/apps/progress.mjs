// A read-only explanation. It never signs, accepts work or advances an escrow.
export function taskProgress(task,payment,{projectId,now=Date.now(),paymentError=false}={}) {
 const paid=!!task.agreement,phase=paymentError?'payment_unknown':paid?payment.state:task.state;
 const next=[];
 const add=(actor,operation,label,extra={})=>next.push({actor,operation,label,...extra});
 if(paymentError)add('any','public_task_progress','Refresh payment state');
 else if(!paid){
  if(task.state==='open')add('worker','app_task_claim','Claim task');
  if(task.state==='claimed'&&task.leaseUntil<=now)add('worker','app_task_claim','Claim expired task');
  else if(task.state==='claimed')add('worker','app_task_deliver','Submit work');
  if(task.state==='submitted')add('requester','app_task_accept','Review delivered work');
 }else{
  const available=new Set(payment.nextActions??[]);
  if(available.has('fund'))add('requester','app_task_payment_prepare','Fund agreement',{action:'fund'});
  if(available.has('claim'))add('worker','app_task_payment_prepare','Claim funded agreement',{action:'claim'});
  if(available.has('deliver'))add('worker',task.state==='submitted'?'app_task_payment_prepare':'app_task_deliver',task.state==='submitted'?'Record delivery onchain':'Submit work',task.state==='submitted'?{action:'deliver'}:{});
  if(available.has('accept'))add('requester',task.state==='accepted'?'app_task_payment_prepare':'app_task_accept',task.state==='accepted'?'Approve payment onchain':'Review delivered work',task.state==='accepted'?{action:'accept'}:{});
  if(available.has('settle'))add('party','app_task_payment_prepare','Settle after deadline',{action:'settle'});
  if(available.has('review'))add('party','public_deal_case','Check arbitration case');
  if(available.has('withdraw'))add('party','deal_balance','Check withdrawable credit');
 }
 return {profile:'claus-task-progress/1',projectId,taskId:task.id,revision:task.revision,observedAt:now,
  phase,taskState:task.state,payment:!paid?{state:'not_bound',asset:null}:paymentError?{state:'unknown',asset:task.agreement.asset??'ETH'}:
   {state:payment.state,asset:task.agreement.asset??'ETH',amountUnits:task.agreement.priceWei,chainId:task.agreement.chainId,contract:task.agreement.contract,agreementId:task.agreement.id,blockNumber:payment.blockNumber,withdrawal:'not_observed'},
  parties:{requester:task.authorId,worker:task.assigneeId??null},next,
  deadlines:{claimExpiresAt:paid?null:task.leaseUntil??null,deliveryDue:paid?task.agreement.deliveryDue*1000:null,reviewDue:payment?.value?.reviewDue?Number(payment.value.reviewDue)*1000:null,resolutionDue:payment?.value?.resolutionDue?Number(payment.value.resolutionDue)*1000:null},
  receipt:task.receipt??null,
  meaning:'Next steps describe recorded state, not permission or transaction success. No bound agreement means payment is not established. Credit is not a wallet transfer; read the current balance before withdrawing. Advisory review does not stop escrow deadlines.'};
}
