import {publicWorkRejection} from './network-failure.js';
// Operational observations only. Never turns a retry into a second payment.
export function diagnoseFailure(code:string,uncertainWrite=false){
 if(publicWorkRejection(code))return {category:'rejected-work-publication',next:'This code is a fixed local work-publisher validation rejection before a document write. Inspect the same original work and its public observations; preserve private evidence. No payment or replacement operation is involved.',automaticReplacement:false};
 const rules:[RegExp,string,string][]=[[/budget|allowance_exhausted|capacity_reached/,'budget','Read spent and reserved balances; preserve existing reservations.'],[/insufficient_funds|balance_too_low/,'funding','Compare actual asset balance and ETH gas with the existing spending allowance.'],[/approval|insufficient_allowance/,'token-approval','Read exact token allowance and original approval receipt before preparing anything else.'],[/scope|revoked|expired|unauthorized/,'authority','Read the current grant; stop actions outside its scope.'],[/revert|simulation|implementation|contract/,'contract','Read the exact revert and contract version; do not submit unchanged calldata.'],[/429|rate_limit|timeout|rpc|unavailable|503/,'provider','Honor Retry-After; retry bounded reads and reconcile submitted actions by their original ID.']];
 const rule=rules.find(([pattern])=>pattern.test(code));return {category:uncertainWrite?'uncertain-write':rule?.[1]??'unknown',next:uncertainWrite?'Look up the original request, nonce or transaction hash. Do not create a replacement.':rule?.[2]??'Inspect original evidence before changing state.',automaticReplacement:false};
}
function units(value:any){return typeof value==='string'&&/^\d+$/.test(value)?BigInt(value):null;}
export function walletForecast(wallet:any,previous:any,observedAt=Date.now()){
 const account=wallet?.account,rows=[];
 for(const asset of ['ETH','CLAUS']){
  const token=asset==='CLAUS',policy=token?wallet?.claus?.policy:wallet?.policy;
  const balance=units(token?wallet?.claus?.balanceUnits:wallet?.balanceWei),cap=units(policy?.principal),spent=units(token?account?.claus_spent:account?.principal_spent),reserved=units(token?account?.claus_reserved:account?.principal_reserved),perJob=units(policy?.perJob);
  if([balance,cap,spent,reserved,perJob].some(x=>x===null)){rows.push({asset,status:'unknown'});continue;}
  const authorization=cap!-spent!-reserved!,cash=balance!-reserved!,available=authorization<cash?authorization:cash,remaining=available>0n?available:0n;
  const old=previous?.assets?.find((x:any)=>x.asset===asset),oldSpent=units(old?.spentUnits),elapsed=observedAt-Number(previous?.observedAt),delta=oldSpent===null?null:spent!-oldSpent;
  const depletionMs=delta!==null&&delta>0n&&elapsed>=60000?Number(remaining*BigInt(Math.floor(elapsed))/delta):null;
  rows.push({asset,status:remaining===0n?'exhausted':perJob!>0n&&remaining<perJob!*3n?'low':'available',balanceUnits:String(balance),spentUnits:String(spent),reservedUnits:String(reserved),availableUnits:String(remaining),maximumSizeJobs:perJob!>0n?String(remaining/perJob!):null,depletionAt:depletionMs!==null&&Number.isSafeInteger(depletionMs)&&depletionMs<365*86400000?new Date(observedAt+depletionMs).toISOString():null});
 }
 return {observedAt,assets:rows,meaning:'Forecast from observed spending, not a promise. Gas, model budgets and exact current grants still apply. No automatic refill.'};
}
