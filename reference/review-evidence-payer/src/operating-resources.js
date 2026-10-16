import {createPublicClient,http,parseAbi} from 'viem';
import {base} from 'viem/chains';

export const RESOURCE_PAYER='0xa46a89b5b3504c1c999696de8173ec9b2eb0a01a';
export const RESOURCE_USDC='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const uint=x=>typeof x==='string'&&/^(0|[1-9][0-9]{0,17})$/.test(x)?BigInt(x):null;
const unavailable=reason=>({state:'unavailable',reason});
const abi=parseAbi(['function balanceOf(address) view returns(uint256)']);

// Both fixed public endpoints are already used by Claus. Retry the whole
// read on one endpoint so a snapshot never combines providers or blocks.
const CASH_RPC_URLS=['https://mainnet.base.org','https://base-rpc.publicnode.com'];
export async function readPayerCash(createClient=createPublicClient){
 for(const url of CASH_RPC_URLS){
  try{
   const client=createClient({chain:base,transport:http(url,{timeout:1500,retryCount:0})});
   if(await client.getChainId()!==8453)throw Error('wrong_chain');
   const block=await client.getBlock({blockTag:'latest'});
   if(typeof block.number!=='bigint'||block.number<0n||!/^0x[0-9a-f]{64}$/i.test(block.hash??''))throw Error('invalid_cash_anchor');
   const [eth,usdc]=await Promise.all([client.getBalance({address:RESOURCE_PAYER,blockNumber:block.number}),client.readContract({address:RESOURCE_USDC,abi,functionName:'balanceOf',args:[RESOURCE_PAYER],blockNumber:block.number})]);
   return {state:'available',chainId:8453,blockNumber:String(block.number),blockHash:block.hash,ethWei:String(eth),usdcMicro:String(usdc)};
  }catch{ /* No cached balance or zero substitute may admit spending. */ }
 }
 throw Error('capital_cash_unavailable');
}

export async function readResourceBudget(db){
 const [row]=await db`SELECT ceiling::text,committed::text,(ceiling-committed)::text AS remaining,
  ((SELECT COALESCE(SUM(reserved_max),0) FROM claus_inference WHERE accounted_cost IS NULL)+
   (SELECT COALESCE(SUM(reserved_max),0) FROM claus_credit_work WHERE accounted_cost IS NULL))::text AS held,
  ((SELECT COALESCE(SUM(accounted_cost),0) FROM claus_inference)+
   (SELECT COALESCE(SUM(accounted_cost),0) FROM claus_credit_work))::text AS settled,
  (SELECT COALESCE(SUM(allocated),0)::text FROM claus_credit_pool) AS prepaid,
  (SELECT deposit_address FROM claus_credit_pool WHERE id=true) AS deposit_address,
  (SELECT key_id FROM claus_credit_pool WHERE id=true) AS key_id
  FROM claus_payment_budget WHERE id=true`;
 if(!row||[row.ceiling,row.committed,row.remaining,row.held,row.settled,row.prepaid].some(x=>uint(x)===null)||
  uint(row.ceiling)-uint(row.committed)!==uint(row.remaining)||uint(row.held)+uint(row.settled)+uint(row.prepaid)!==uint(row.committed))throw Error('accounting_unavailable');
 return {state:'available',limitMicroUsdc:row.ceiling,committedMicroUsdc:row.committed,remainingMicroUsdc:row.remaining,
  heldMicroUsdc:row.held,settledMicroUsdc:row.settled,prepaidAllocationMicroUsdc:row.prepaid,
  binding:{address:row.deposit_address,keyId:row.key_id}};
}

async function boundedJson(response){
 if(!response.ok)throw Error('provider_read_unavailable');
 const reader=response.body?.getReader();if(!reader)throw Error('provider_read_unavailable');let size=0;const chunks=[];
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>32768){await reader.cancel();throw Error('provider_response_too_large');}chunks.push(part.value);}}
 finally{reader.releaseLock();}
 return JSON.parse(Buffer.concat(chunks).toString());
}

export async function readProviderCash(env,request=fetch){
 if(!/^inf_[a-f0-9]{32}$/.test(env.SURPLUS_CREDIT_KEY??''))return unavailable('provider_not_configured');
 const get=async path=>boundedJson(await request('https://api.surplusintelligence.ai/v1/payments/'+path,{method:'GET',redirect:'error',headers:{authorization:'Bearer '+env.SURPLUS_CREDIT_KEY},signal:AbortSignal.timeout(3000)}));
 const [balance,deposit,topup]=await Promise.all([get('balance'),get('deposit-address'),get('auto-topup')]);
 const credit=uint(balance.credit_balance_usdc),cash=uint(balance.usdc_available_usdc),pending=uint(balance.pending_deposit_usdc);
 if(balance.account_status!=='active'||balance.prefunded_usdc_enabled!==true||credit===null||cash!==credit||pending===null||
  typeof topup.enrolled!=='boolean'||deposit.chain_id!==8453||String(deposit.token_address).toLowerCase()!==RESOURCE_USDC||!/^0x[a-f0-9]{40}$/i.test(deposit.address??''))throw Error('provider_balance_ambiguous');
 return {state:'available',creditMicroUsdc:String(credit),pendingMicroUsdc:String(pending),providerAutoTopup:topup.enrolled===true,
  binding:{address:deposit.address.toLowerCase(),keyId:env.SURPLUS_CREDIT_KEY_ID}};
}

// This proposes a fixed-destination cash top-up. It never reserves money,
// changes a budget, signs, broadcasts, or credits the compute ledger.
export function proposeFunding({budget,provider,onchain}){
 const result={automaticFundingEnabled:false,automaticFundingScope:'manual_cash_topup_proposal',executable:false,asset:'USDC',chainId:8453};
 if([budget,provider,onchain].some(x=>x?.state!=='available'))return {...result,state:'unknown',reason:'resource_read_incomplete'};
 const remaining=uint(budget.remainingMicroUsdc),held=uint(budget.heldMicroUsdc),cash=uint(onchain.usdcMicro),credit=uint(provider.creditMicroUsdc),pending=uint(provider.pendingMicroUsdc);
 if([remaining,held,cash,credit,pending].includes(null))return {...result,state:'unknown',reason:'resource_amount_invalid'};
 if(!budget.binding?.address||String(budget.binding.address).toLowerCase()!==provider.binding?.address||budget.binding.keyId!==provider.binding.keyId)return {...result,state:'blocked',reason:'provider_binding_changed'};
 if(provider.providerAutoTopup)return {...result,state:'blocked',reason:'external_auto_topup_enabled'};
 if(pending>0n)return {...result,state:'waiting',reason:'original_provider_deposit_pending'};
 if(remaining===0n)return {...result,state:'blocked',reason:'operating_budget_exhausted'};
 if(remaining<2000000n)return {...result,state:'limited',reason:'full_request_reservation_unavailable'};
 if(credit>=2000000n)return {...result,state:'funded',reason:'provider_cash_above_request_ceiling'};
 // Hold the maximum unresolved payment exposure plus a 20-USDC wallet reserve.
 const spendable=cash>held+20000000n?cash-held-20000000n:0n;
 const gap=10000000n-credit;
 const amount=[gap,spendable,remaining].reduce((a,b)=>a<b?a:b);
 if(amount<2000000n)return {...result,state:'blocked',reason:'cash_or_budget_reserve'};
 return {...result,state:'proposal',reason:'explicit_funding_authorization_required',amountMicroUsdc:String(amount),
  to:provider.binding.address,token:RESOURCE_USDC,from:RESOURCE_PAYER,
  ledger:'A token transfer is not compute credit. Confirm the original transfer and provider deposit before crediting or admitting work.'};
}

// A cash balance cannot increase a lifetime allowance. These are present-time
// reservation capacities, not prepaid jobs, runway estimates or new grants.
export function operatingCapacity({budget,provider,onchain}) {
 const result={automaticFundingEnabled:false,automaticFundingScope:'manual_cash_topup_proposal',authorizationChanged:false};
 if(budget?.state!=='available')return {...result,state:'unknown',reason:'budget_unavailable'};
 const remaining=uint(budget.remainingMicroUsdc),held=uint(budget.heldMicroUsdc);
 if(remaining===null||held===null)return {...result,state:'unknown',reason:'budget_invalid'};
 const credit=provider?.state==='available'?uint(provider.creditMicroUsdc):null;
 const cash=onchain?.state==='available'?uint(onchain.usdcMicro):null;
 return {...result,state:remaining===0n?'exhausted':remaining<2000000n?'limited':'available',
  remainingAuthorizationMicroUsdc:String(remaining),unresolvedExposureMicroUsdc:String(held),
  nativeTwoUsdcReservations:String(remaining/2000000n),payerThreeUsdcReservations:String(remaining/3000000n),
  ...(credit!==null?{providerCreditMicroUsdc:String(credit)}:{}),
  ...(cash!==null?{payerCashMicroUsdc:String(cash)}:{}),
  fullRequestCashBufferAvailable:credit===null||cash===null?null:credit>=2000000n||cash>=2000000n,
  nextAction:remaining===0n?'renew_authorization_before_new_cost':remaining<2000000n?'use_smaller_authorized_requests_or_renew_authorization':'continue_within_existing_authorization',
  meaning:'Original holds are already deducted. A smaller request may still fit below 2 USDC. Do not refill, release unknown holds or raise limits from these observations.'};
}

export function createOperatingResources({env=process.env,db,request=fetch,onchain=readPayerCash,computeFunding,now=Date.now,deadlineMs=3500,cacheMs=20000}={}){
 let current=null,expires=0;
 const bounded=async(job,reason)=>{let timer;try{return await Promise.race([Promise.resolve().then(job).catch(()=>unavailable(reason)),new Promise(resolve=>{timer=setTimeout(()=>resolve(unavailable(reason)),deadlineMs);})]);}finally{clearTimeout(timer);}};
 const snapshot=async()=>{
  if(current&&now()<expires)return current;
  expires=now()+cacheMs;
  current=(async()=>{
   const [budget,provider,cash]=await Promise.all([bounded(()=>readResourceBudget(db),'budget_unavailable'),bounded(()=>readProviderCash(env,request),'provider_unavailable'),bounded(onchain,'chain_unavailable')]);
   const complete=[budget,provider,cash].every(v=>v.state==='available');
   if(!complete)expires=Math.min(expires,now()+5000);
   const funding=proposeFunding({budget,provider,onchain:cash});
   // The private binding only guides the fixed proposal; it is not an API key.
   const {binding:budgetBinding,...publicBudget}=budget,{binding:providerBinding,...publicProvider}=provider;
   return {version:1,complete,observedAt:new Date(now()).toISOString(),automaticFundingEnabled:false,automaticFundingScope:'manual_cash_topup_proposal',budget:publicBudget,provider:publicProvider,onchain:cash,funding,capacity:operatingCapacity({budget,provider,onchain:cash})};
  })();
  return current;
 };
 // Keep the v1 manual-proposal flag for existing readers. The separately
 // authorized compute service reports its own admission, never a grant or
 // proof that a provider credited a deposit. Re-read it even with cached cash
 // so disabling or expiring the service cannot leave a stale enabled status.
 return async()=>{
  const [value,status]=await Promise.all([snapshot(),bounded(async()=>{
   if(!computeFunding)return unavailable('compute_funding_status_not_configured');
   return {...await computeFunding(),state:'available',observedAt:new Date(now()).toISOString(),scope:'designated_compute_revenue'};
  },'compute_funding_status_unavailable')]);
  return {...value,complete:value.complete&&status.state==='available',computeFunding:status};
 };
}
