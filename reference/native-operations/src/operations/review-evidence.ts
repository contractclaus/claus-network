import {custodyClient} from '../custody-client.js';
const address=(v:unknown)=>typeof v==='string'&&/^0x[0-9a-fA-F]{40}$/.test(v)?v.toLowerCase():null;
const units=(v:unknown)=>typeof v==='string'&&/^[0-9]{1,78}$/.test(v)?v:null;
/** Read-only allowlist: never include balances, private jobs, credentials or API errors. */
export function custodyEvidence(value:any){
 const p=value?.policy,t=value?.claus?.policy;
 if(value?.error||typeof value?.enabled!=='boolean'||value.chainId!==1||!p||!t||
  !address(value.address)||address(value.address)!==address(p.address)||!address(p.contract)||!address(t.contract)||!address(t.token)||
  !units(p.principal)||!units(p.perJob)||!units(p.gas)||!units(p.perTransactionGas)||!units(t.principal)||!units(t.perJob))return null;
 return {available:true,enabled:value.enabled,chainId:1,address:address(value.address),
  eth:{escrow:address(p.contract),perJob:p.perJob,cumulativePrincipal:p.principal},
  claus:{escrow:address(t.contract),token:address(t.token),perJob:t.perJob,cumulativePrincipal:t.principal},
  sharedGas:{asset:'ETH',cumulative:p.gas,perTransaction:p.perTransactionGas},
  scope:'Fixed Jobs escrows only. Token approval is exact and funding is separate. Withdrawal recipient is the same work wallet. No arbitrary transfer, general signing, token-owner or arbitration authority. Limits do not reset on deposits or refunds.',
  evidenceLevel:'current-service-policy-not-proof-of-a-payment'};
}
export async function operationalReviewEvidence(scope:string,{read=()=>custodyClient.tool({operation:'status',input:'{}'}),now=()=>Date.now()}:any={}){
 if(scope!=='web')return {observedAt:new Date(now()).toISOString(),jobsWallet:{available:false,reason:'not_requested_for_scope'}};
 let jobsWallet;try{jobsWallet=custodyEvidence(await read());}catch{}
 return {observedAt:new Date(now()).toISOString(),source:'https://claus-inference.vercel.app/api/jobs/wallet',
  jobsWallet:jobsWallet??{available:false,reason:'current_service_evidence_unavailable'}};
}
