import {amount,digest,integer,requireThat,shape} from '../shared/index.mjs';
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

export function createDeals({store,identity,ports={}}){
 const context=async (chainId,options)=>{integer(chainId);requireThat([1,11155111].includes(chainId),'unsupported_chain');requireThat(ports.context,'deals_not_enabled');return ports.context(chainId,options);};
 return {
  async terms(chainId){if(!ports.context)return {enabled:false,chainId,rules:DEAL_RULES};try{const c=await context(chainId);return {...c.public,rules:DEAL_RULES};}catch(e){if(e.code==='deals_not_enabled')return {enabled:false,chainId,rules:DEAL_RULES};throw e;}},
  async read(chainId,id,kind='deal'){hash(id);requireThat(['deal','plan'].includes(kind),'invalid_deal_input');const c=await context(chainId);return {chainId,contract:c.public.contract,blockNumber:c.public.blockNumber,kind,id,value:await ports.read(c,kind,id),evidence:'Onchain agreement state; project commitment is not independent verification.'};},
  async prepare(actor,projectId,{chainId,action,input}){
   const exit=['refund','settle','cancelUnclaimed','cancelPlan','expirePlan','withdraw'].includes(action);await identity.authorize(actor,exit?'deal.exit':'deal.prepare',{projectId});const p=(await store.read('projects',projectId)).value,owner=(await store.read('principals',p.ownerId))?.value;
   requireThat(owner?.address,'wallet_not_verified');const sender=address(owner.address),c=await context(chainId,{fresh:true}),projectHash='0x'+digest({projectId}).slice(7);
   let method,args,value=0n,id=null;requireThat(input&&typeof input==='object'&&!Array.isArray(input),'invalid_deal_input');
   if(action==='fund'){
    exact(input,['salt','termsHash','worker','priceWei','deliveryDue']);hash(input.salt);hash(input.termsHash);address(input.worker);value=amount(input.priceWei);seconds(input.deliveryDue);
    method='createDeal';args=[input.salt,projectHash,input.termsHash,input.worker,input.deliveryDue];
    id=await ports.id(c,'deal',sender,input.salt);
   }else if(action==='plan'){
    exact(input,['salt','termsHash','worker','priceWei','maximumRuns','intervalSeconds','deliverySeconds','expiresAt']);hash(input.salt);hash(input.termsHash);address(input.worker);const price=amount(input.priceWei);integer(input.maximumRuns,1,100);integer(input.intervalSeconds,60,2592000);integer(input.deliverySeconds,1,2592000);seconds(input.expiresAt);value=price*BigInt(input.maximumRuns);
    method='createPlan';args=[input.salt,projectHash,input.termsHash,input.worker,price,input.maximumRuns,input.intervalSeconds,input.deliverySeconds,input.expiresAt];id=await ports.id(c,'plan',sender,input.salt);
   }else if(['claim','accept','refund','settle','cancelUnclaimed','cancelPlan','expirePlan'].includes(action)){
    exact(input,['id']);id=hash(input.id);method=action==='settle'?'settleExpired':action;args=[id];
   }else if(['deliver','dispute'].includes(action)){
    exact(input,['id','contentHash']);id=hash(input.id);method=action;args=[id,hash(input.contentHash)];
   }else if(action==='run'){
    exact(input,['id','expectedRun']);id=hash(input.id);integer(input.expectedRun,0,99);method='runPlan';args=[id,input.expectedRun];
   }else if(action==='withdraw'){
    exact(input,['amountWei','recipient']);method='withdraw';args=[amount(input.amountWei),address(input.recipient)];
   }else requireThat(false,'invalid_deal_action');
   const prepared=await ports.prepare(c,{sender,method,args,value});
   requireThat(prepared.transaction.chainId===chainId&&prepared.transaction.to.toLowerCase()===c.public.contract.toLowerCase()&&prepared.transaction.from.toLowerCase()===sender.toLowerCase()&&prepared.transaction.value===String(value),'deal_pin_mismatch');
   const transaction=prepared.transaction;
   return {projectId,projectHash,action,id,...prepared,intentHash:digest(transaction),state:'prepared-not-sent',rules:DEAL_RULES,contract:c.public};
  }
 };
}
