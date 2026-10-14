import {amount,canonical,copy,digest,integer,requireThat} from '../shared/index.mjs';
import {validateDealEvidence} from './evidence.mjs';
const commitment=value=>'0x'+digest(value).slice(7);
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const document=(kind,value)=>({version:1,visibility:'public',kind,text:canonical(value),links:[]});

// Connect existing public tasks to the existing escrow. This port never signs,
// broadcasts or changes agreement terms after creation.
export function createTaskPayments({identity,store,ports,deals,evidence,now=()=>Date.now()}) {
 async function wallet(reader,principalId){
  const p=(await reader.read('principals',principalId))?.value;
  requireThat(p,'wallet_not_verified');
  const project=p.address?null:(await reader.read('projects',p.projectId))?.value;
  const owner=p.address?p:project?(await reader.read('principals',project.ownerId))?.value:null;
  requireThat(/^0x[0-9a-fA-F]{40}$/.test(owner?.address??''),'wallet_not_verified');return owner.address;
 }
 async function sender(actor,projectId,scope,reader=store){
  await identity.authorize(actor,scope,{projectId},reader);
  const credential=await identity.credential(actor,reader),project=(await reader.read('projects',projectId))?.value;
  return {principalId:credential.principalId,address:await wallet(reader,project.ownerId)};
 }
 const resultDocument=task=>document('result',{version:1,appId:task.agreement.appId,taskId:task.id,agreementId:task.agreement.id,output:task.output});
 async function observe(task){
  const a=task.agreement;requireThat(a,'task_payment_missing');
  const c=await ports.context(a.chainId,{fresh:true});
  requireThat(same(c.public.contract,a.contract)&&same(c.public.codeHash,a.codeHash),'deal_pin_mismatch');
  let value;try{value=await ports.read(c,'deal',a.id);}catch(e){if(e.code!=='not_found')throw e;}
  if(value){requireThat(same(value.buyer,a.buyer)&&same(value.worker,a.worker)&&same(value.termsHash,a.termsHash)&&same(value.projectId,a.projectHash)&&String(value.amount)===a.priceWei&&Number(value.deliveryDue)===a.deliveryDue,'payment_mismatch');
   if(value.state>=3&&value.resultHash&&!/^0x0+$/.test(value.resultHash))requireThat(task.output!==undefined&&same(value.resultHash,validateDealEvidence(resultDocument(task))),'result_mismatch');
  }
  const state=Number(value?.state??0),stamp=Number(c.public.observedBlockTime),expired=stamp>a.deliveryDue;
  const status=state===0?'unfunded':state===1?'funded':state===2?'working':state===3?'submitted':state===4?'disputed':String(value.workerPaid)===a.priceWei?'credited':String(value.workerPaid)==='0'?'refunded':'split';
  const next=state===0?!expired&&task.state!=='cancelled'?['fund']:[]:state===1?expired?['settle','cancelUnclaimed','refund']:['claim','cancelUnclaimed','refund']:state===2?expired?['settle','refund']:['deliver','refund']:state===3?stamp>Number(value.reviewDue)?['accept','settle','refund']:['accept','refund','dispute']:state===4?stamp>Number(value.resolutionDue)?['accept','settle','refund']:['accept','refund','review']:['withdraw'];
  return {agreement:copy(a),state:status,onchainState:state,value:value??null,blockNumber:c.public.blockNumber,blockHash:c.public.blockHash,observedBlockTime:c.public.observedBlockTime,nextActions:next,
   settlement:'credited means withdrawable escrow credit, not a wallet transfer. Use deal_balance and deal_prepare withdraw with your own signer.'};
 }
 return {
  async create(actor,reader,appId,task,spec,{payerProjectId,chainId,priceWei,deliveryDue}){
   requireThat(!task.agreement&&task.state==='claimed'&&task.leaseUntil>now(),'app_task_busy');
   const who=await sender(actor,payerProjectId,'deal.prepare',reader);requireThat(who.principalId===task.authorId,'scope_denied');
   if(task.reviewCommission)requireThat(deliveryDue*1000<=task.reviewCommission.reviewExpiresAt,'task_review_deadline');
   integer(chainId);requireThat([1,11155111].includes(chainId),'unsupported_chain');integer(deliveryDue,Math.floor(now()/1000)+1,Math.floor(now()/1000)+2592000);
   requireThat(ports.context,'deals_not_enabled');const c=await ports.context(chainId,{fresh:true});requireThat(c.public.enabled,'deals_not_enabled');
   const price=amount(priceWei);requireThat(price>0n&&price<=BigInt(c.public.maximumDealWei),'invalid_amount');
   const worker=await wallet(reader,task.assigneeId);requireThat(!same(worker,who.address)&&!same(worker,c.public.arbiter)&&!same(who.address,c.public.arbiter),'deal_party_required');
   const terms=document('terms',{version:1,appId,taskId:task.id,appVersion:task.version,generation:task.generation,requesterId:task.authorId,workerId:task.assigneeId,buyer:who.address,worker,input:task.input,outputSchema:spec.outputSchema,chainId,contract:c.public.contract,priceWei,deliveryDue,reviewSeconds:86400,disputeSeconds:259200,...(task.reviewPolicy?{reviewPolicy:task.reviewPolicy,reviewAuthority:'advisory_only'}:{}),...(task.reviewCommission?{reviewCommission:task.reviewCommission}:{})});
   const termsHash=validateDealEvidence(terms),salt=commitment({kind:'claus-task-payment/1',appId,taskId:task.id,generation:task.generation});
   return {version:1,appId,payerProjectId,requesterId:task.authorId,workerId:task.assigneeId,buyer:who.address,worker,chainId,contract:c.public.contract,codeHash:c.public.codeHash,projectHash:commitment({projectId:payerProjectId}),priceWei,deliveryDue,salt,termsHash,terms,id:await ports.id(c,'deal',who.address,salt)};
  },
  observe,
  async checkTaskAction(task,action){
   const payment=await observe(task),state=payment.onchainState;
   if(action==='deliver')requireThat(state===2&&Number(payment.observedBlockTime)<=task.agreement.deliveryDue,'task_payment_not_ready');
   if(action==='accept')requireThat([3,4].includes(state)||state===5&&String(payment.value.workerPaid)===task.agreement.priceWei,'task_payment_not_ready');
   if(action==='cancel')requireThat(state===5&&String(payment.value.workerPaid)==='0'||state===0&&Number(payment.observedBlockTime)>task.agreement.deliveryDue,'task_payment_exit_required');
  },
  async prepare(actor,senderProjectId,task,action){
   requireThat(['fund','claim','deliver','accept','cancelUnclaimed','refund','settle'].includes(action),'invalid_deal_action');
   const who=await sender(actor,senderProjectId,['cancelUnclaimed','refund','settle'].includes(action)?'deal.exit':'deal.prepare'),a=task.agreement;requireThat(a,'task_payment_missing');
   const buyer=who.principalId===a.requesterId&&same(who.address,a.buyer),worker=who.principalId===a.workerId&&same(who.address,a.worker);
   requireThat(action==='settle'?buyer||worker:['fund','accept','cancelUnclaimed'].includes(action)?buyer:worker,'deal_party_required');
   const payment=await observe(task),state=payment.onchainState;
   if(state===5||action==='fund'&&state>0||action==='claim'&&state>=2||action==='deliver'&&state>=3)return {state:'already-recorded',payment,transaction:null};
   requireThat(payment.nextActions.includes(action),'task_payment_not_ready');
   let input={id:a.id};
   if(action==='fund'){
    requireThat(senderProjectId===a.payerProjectId&&task.state==='claimed','task_payment_not_ready');
    await evidence.publish(actor,senderProjectId,a.terms);
    input={salt:a.salt,termsHash:a.termsHash,worker:a.worker,priceWei:a.priceWei,deliveryDue:a.deliveryDue};
   }
   if(action==='deliver'){
    requireThat(task.state==='submitted'&&task.output!==undefined,'task_payment_not_ready');
    const result=await evidence.publish(actor,senderProjectId,resultDocument(task));input.contentHash=result.hash;
   }
   if(action==='accept')requireThat(task.state==='accepted','task_payment_not_ready');
   const prepared=await deals.prepare(actor,senderProjectId,{chainId:a.chainId,action,input});
   requireThat(prepared.id===a.id,'payment_mismatch');return {...prepared,payment};
  }
 };
}
