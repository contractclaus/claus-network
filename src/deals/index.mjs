import {amount,digest,integer,requireThat,shape} from '../shared/index.mjs';
import {dealAsset,isTokenDeal,assetFields} from './assets.mjs';
export {dealAbi} from './abi.mjs';

const hash=x=>{requireThat(/^0x[0-9a-fA-F]{64}$/.test(x??''),'invalid_deal_input');return x;};
const address=x=>{requireThat(/^0x[0-9a-fA-F]{40}$/.test(x??'')&&!/^0x0{40}$/i.test(x),'invalid_deal_input');return x;};
const seconds=x=>integer(x,1,Number.MAX_SAFE_INTEGER);
const exact=(v,keys)=>shape(v,keys);
export const DEAL_RULES=Object.freeze({asset:'native ETH',reviewSeconds:86400,disputeSeconds:259200,maximumDurationSeconds:2592000,
 settlement:'Buyer acceptance or disclosed review timeout pays the provider. A signed arbitration decision can split only the original agreement. Unresolved disputes refund the buyer at the fixed deadline.',
 authority:'Immutable agreement rules. Admission can pause new deposits, never existing settlements or withdrawals. No admin sweep, proxy, fee or arbitrary recipient.',
 recurring:'Pre-funded exact-price runs triggered only by the buyer or its own onchain signer. Explicit expectedRun prevents duplicate triggers. Cancellation returns only unspent budget; prior work remains live. A failed or partially paid run stops further runs.',
 evidence:'Project, terms and result hashes are commitments, not certification. Requester acceptance is not independent review. No quality guarantee or automatic IMD arbitration is implied.',
 signing:'Preparation sends no transaction. Use your own authorized signer and retain the original transaction hash and nonce on timeout.'});

const rulesFor=asset=>isTokenDeal(asset)?{...DEAL_RULES,asset:'CLAUS',units:'All amount/price Wei fields are 18-decimal CLAUS base units, not ETH.',approval:'Fund/plan may return approval-required. Sign only the exact allowance, wait for confirmation, then prepare the same funding action again.'}:DEAL_RULES;

export function createDeals({store,identity,ports={}}){
 const context=async (chainId,options)=>{integer(chainId);requireThat([1,11155111].includes(chainId),'unsupported_chain');requireThat(ports.context,'deals_not_enabled');return ports.context(chainId,options);};
 return {
  async terms(chainId,asset){dealAsset(asset);if(!ports.context)return {enabled:false,chainId,...assetFields(asset),rules:rulesFor(asset)};try{const c=await context(chainId,{asset});return {...c.public,rules:rulesFor(asset)};}catch(e){if(e.code==='deals_not_enabled')return {enabled:false,chainId,...assetFields(asset),rules:rulesFor(asset)};throw e;}},
  async balance(chainId,account,asset){dealAsset(asset);address(account);const c=await context(chainId,{asset});return{chainId,...assetFields(asset),contract:c.public.contract,blockNumber:c.public.blockNumber,address:account,creditWei:String(await ports.credit(c,account))};},
  async read(chainId,id,kind='deal',asset){dealAsset(asset);hash(id);requireThat(['deal','plan'].includes(kind),'invalid_deal_input');const c=await context(chainId,{asset});return {chainId,...assetFields(asset),contract:c.public.contract,blockNumber:c.public.blockNumber,kind,id,value:await ports.read(c,kind,id),evidence:'Onchain agreement state; project commitment is not independent verification.'};},
  async prepare(actor,projectId,{chainId,action,input,asset}){dealAsset(asset);
   const exit=['refund','settle','cancelUnclaimed','cancelPlan','expirePlan','withdraw','resolve'].includes(action);await identity.authorize(actor,exit?'deal.exit':'deal.prepare',{projectId});const p=(await store.read('projects',projectId)).value,owner=(await store.read('principals',p.ownerId))?.value;
   requireThat(owner?.address,'wallet_not_verified');const sender=address(owner.address),c=await context(chainId,{fresh:true,asset}),projectHash='0x'+digest({projectId}).slice(7);
   let method,args,value=0n,id=null,deposit=0n;requireThat(input&&typeof input==='object'&&!Array.isArray(input),'invalid_deal_input');
   if(action==='fund'){
    exact(input,['salt','termsHash','worker','priceWei','deliveryDue']);hash(input.salt);hash(input.termsHash);address(input.worker);value=amount(input.priceWei);seconds(input.deliveryDue);
    deposit=value;method='createDeal';args=[input.salt,projectHash,input.termsHash,input.worker,...(isTokenDeal(asset)?[deposit]:[]),input.deliveryDue];
    id=await ports.id(c,'deal',sender,input.salt);
   }else if(action==='plan'){
    exact(input,['salt','termsHash','worker','priceWei','maximumRuns','intervalSeconds','deliverySeconds','expiresAt']);hash(input.salt);hash(input.termsHash);address(input.worker);const price=amount(input.priceWei);integer(input.maximumRuns,1,100);integer(input.intervalSeconds,60,2592000);integer(input.deliverySeconds,1,2592000);seconds(input.expiresAt);value=price*BigInt(input.maximumRuns);
    deposit=value;method='createPlan';args=[input.salt,projectHash,input.termsHash,input.worker,price,input.maximumRuns,input.intervalSeconds,input.deliverySeconds,input.expiresAt];id=await ports.id(c,'plan',sender,input.salt);
   }else if(['claim','accept','refund','settle','cancelUnclaimed','cancelPlan','expirePlan'].includes(action)){
    exact(input,['id']);id=hash(input.id);method=action==='settle'?'settleExpired':action;args=[id];
   }else if(['deliver','dispute'].includes(action)){
    exact(input,['id','contentHash']);id=hash(input.id);method=action;args=[id,hash(input.contentHash)];
   }else if(action==='run'){
    exact(input,['id','expectedRun']);id=hash(input.id);integer(input.expectedRun,0,99);method='runPlan';args=[id,input.expectedRun];
   }else if(action==='resolve'){
    exact(input,['caseId']);const record=(await store.read('deal-cases',input.caseId))?.value,r=record?.resolution;requireThat(record?.state==='resolution-ready'&&r?.chainId===chainId&&r.contract.toLowerCase()===c.public.contract.toLowerCase(),'resolution_unavailable');method='resolve';id=r.dealId;args=[id,BigInt(r.workerAmount),r.evidenceHash,r.expiresAt,r.signature];
   }else if(action==='withdraw'){
    exact(input,['amountWei','recipient']);method='withdraw';args=[amount(input.amountWei),address(input.recipient)];
   }else requireThat(false,'invalid_deal_action');
   if(isTokenDeal(asset))value=0n;
   if(isTokenDeal(asset)&&deposit>0n){
    const stamp=Number(c.public.observedBlockTime),due=action==='fund'?input.deliveryDue:input.expiresAt;
    requireThat(c.public.enabled,'deals_not_enabled');
    requireThat(amount(input.priceWei)<=BigInt(c.public.maximumDealWei)&&due>stamp&&due<=stamp+2592000&&!/^0x0+$/.test(input.termsHash)&&![sender,c.public.arbiter].some(a=>a.toLowerCase()===input.worker.toLowerCase())&&sender.toLowerCase()!==c.public.arbiter.toLowerCase(),'invalid_deal_input');
    let existing;try{existing=await ports.read(c,action==='fund'?'deal':'plan',id);}catch(e){if(e.code!=='not_found')throw e;}requireThat(!existing,'deal_already_funded');
    const approval=await ports.approval(c,{sender,amount:deposit});
    if(approval){requireThat(approval.transaction.chainId===chainId&&approval.transaction.to.toLowerCase()===c.public.token.toLowerCase()&&approval.transaction.from.toLowerCase()===sender.toLowerCase()&&approval.transaction.value==='0'&&approval.approval.spender.toLowerCase()===c.public.contract.toLowerCase()&&approval.approval.amountUnits===String(deposit),'deal_pin_mismatch');
     return {projectId,projectHash,action,id,...approval,intentHash:digest(approval.transaction),state:'approval-required',rules:rulesFor(asset),contract:c.public};}
   }
   const prepared=await ports.prepare(c,{sender,method,args,value});
   requireThat(prepared.transaction.chainId===chainId&&prepared.transaction.to.toLowerCase()===c.public.contract.toLowerCase()&&prepared.transaction.from.toLowerCase()===sender.toLowerCase()&&prepared.transaction.value===String(value),'deal_pin_mismatch');
   const transaction=prepared.transaction;
   return {projectId,projectHash,action,id,...prepared,intentHash:digest(transaction),state:'prepared-not-sent',rules:rulesFor(asset),contract:c.public};
  }
 };
}
