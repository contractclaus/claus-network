import {recoverTypedDataAddress}from'viem';
import {canonical,digest,requireThat}from'../src/shared/index.mjs';
import {reserve,settleReservation}from'../src/billing/index.mjs';
import {createImdOracleProvider,IMD_ORACLE,boundedResponse}from'../adapters/imd-oracle.mjs';
import {createImdPayment}from'../adapters/imd-payment.mjs';
import {createImdCostVerifier}from'../adapters/imd-cost.mjs';
import {oracleInput,decisionInput,validateDealDecision}from'../src/deals/decision.mjs';
import {verifyDealOracle}from'../adapters/deal-oracle-proof.mjs';

export const RESOLUTION_TYPES={Resolution:[{name:'dealId',type:'bytes32'},{name:'workerAmount',type:'uint256'},{name:'evidenceHash',type:'bytes32'},{name:'expiresAt',type:'uint64'}]};
const ACCOUNT='deal-arbitration-v1',ASSET='eip155:1/erc20:'+IMD_ORACLE.asset;
export function arbitrationPorts({store,sealer,paymentSigner,arbiterSigner,mainnetClient,dealPorts,pins,nativeOrigin,nativeSecret,fetcher=fetch,now=()=>Date.now()}){
 requireThat(nativeOrigin==='https://claus-agent.vercel.app'&&nativeSecret&&paymentSigner.address.toLowerCase()!==arbiterSigner.address.toLowerCase(),'invalid_arbitration_host');
 const provider=createImdOracleProvider({store,sealer,now,fetch:fetcher,resolveInput:async(id,inputHash)=>{const c=(await store.read('deal-cases',id))?.value;requireThat(c,'case_missing');const input=oracleInput(c);requireThat(digest(input)===inputHash,'case_binding_mismatch');return input;}});
 async function allowed(caseId,reader=store){const c=(await reader.read('deal-cases',caseId))?.value,p=(await reader.read('network-capabilities','deal-arbitration'))?.value;return c&&p?.enabled===true&&p.generation===c.admissionGeneration&&!['blocked','failed','resolution-ready'].includes(c.state);}
 const payment=createImdPayment({store,sealer,provider,signer:paymentSigner,now,authorize:async(i,tx)=>{const a=(await tx.read('deal-oracle-allocations',i.offerId))?.value;if(!a||!await allowed(a.caseId,tx)||a.billing!=='reserved'||a.maximum!==i.amount||a.payer!==i.payer)return false;if(i.challenge){const q=i.challenge.quote;if(q.action!=='oracle.request'||q.policyVersion!=='oracle-1'||q.inputHash!==a.inputHash.slice(7))return false;}return true;}});
 const verifier=createImdCostVerifier({client:mainnetClient,payer:paymentSigner.address,readPayment:async id=>(await store.read('imd-payments',id))?.value});
 async function settleCost(offer,state,inputHash){const prior=(await store.read('deal-oracle-allocations',offer.id))?.value;if(prior?.billing==='settled')return prior.receipt;const receipt=await verifier.receipt({offer,state,inputHash});if(!receipt)return null;await store.transaction(async tx=>{const old=await tx.read('deal-oracle-allocations',offer.id);requireThat(old,'allocation_missing');if(old.value.billing==='settled'){requireThat(canonical(old.value.receipt)===canonical(receipt),'cost_receipt_conflict');return;}const key=digest({provider:receipt.provider,id:receipt.id}),prior=await tx.read('cost-receipts',key);requireThat(!prior,'cost_receipt_conflict');await settleReservation(tx,ACCOUNT,ASSET,offer.maximum,receipt.actual);await tx.write('cost-receipts',key,{caseId:old.value.caseId,receipt},0);await tx.write('deal-oracle-allocations',offer.id,{...old.value,billing:'settled',receipt},old.revision);});return receipt;}
 async function native(path,body){let r;try{r=await fetcher(nativeOrigin+'/internal/network/reviews'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+nativeSecret,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(25000)});}catch{throw Object.assign(Error('native_outcome_unknown'),{code:'native_outcome_unknown'});}if(r.status===404&&!body){const j=JSON.parse(await boundedResponse(r,10000));requireThat(j.error==='network_review_not_found','native_review_unavailable');return{state:'missing'};}if(r.status===429){await r.body?.cancel();return {state:'waiting'};}requireThat(r.ok,'native_review_unavailable');return JSON.parse(await boundedResponse(r,250000));}
 async function fresh(v){const c=await dealPorts.context(v.chainId,{fresh:true}),d=await dealPorts.read(c,'deal',v.dealId);requireThat(c.public.contract.toLowerCase()===v.contract.toLowerCase()&&c.public.arbiter.toLowerCase()===arbiterSigner.address.toLowerCase()&&canonical(d)===canonical(v.deal),'deal_state_changed');const block=await c.client.getBlock({blockNumber:BigInt(v.observation.blockNumber)});requireThat(block.hash===v.observation.blockHash,'deal_observation_reorg');return c;}
 return {
  async advance(v,{checkpoint,stillAllowed}){
   const expected=oracleInput(v),inputHash=digest(expected);
   let offer=v.offer;
   if(!offer){requireThat(await stillAllowed(),'authority_closed');offer=await provider.quote({projectId:v.id,inputHash,quoteId:'deal-oracle:'+v.id});await checkpoint({offer,state:'oracle-pending'});}
   await store.transaction(async tx=>{const old=await tx.read('deal-oracle-allocations',offer.id);if(old){requireThat(old.value.caseId===v.id&&old.value.inputHash===inputHash,'case_binding_mismatch');return;}requireThat(await allowed(v.id,tx),'authority_closed');await reserve(tx,ACCOUNT,ASSET,offer.maximum);await tx.write('deal-oracle-allocations',offer.id,{caseId:v.id,inputHash,maximum:offer.maximum,payer:paymentSigner.address.toLowerCase(),billing:'reserved',offer,createdAt:now()},0);});
   let state=await payment.status(offer.id);
   if(!state){requireThat(await stillAllowed(),'authority_closed');state=await payment.prepare(offer.id);}
   if(state.state==='prepared'){requireThat(await stillAllowed(),'authority_closed');state=await payment.submit(offer.id);}
   state=await payment.reconcile(offer.id);
   const paid=await settleCost(offer,state,inputHash),requestId=state.outcome?.admission?.result?.requestId;
   if(!paid||!requestId)return {state:'oracle-pending'};
   requireThat(state.outcome?.admission?.result?.kind==='oracle','oracle_admission_mismatch');
   let oracle=v.oracle;
   if(!oracle){const r=await provider.oracle(requestId);if(!r.complete)return ['disagreed','blocked','mismatch','refused','failed'].includes(r.state)?{state:'failed',error:'oracle_'+r.state,oraclePublic:{requestId,state:r.state}}:{state:'oracle-pending',oraclePublic:{requestId,state:r.state}};oracle={requestId,expected,request:r.request,attestation:r.attestation};await checkpoint({oracle,oraclePublic:{requestId,state:'attested',url:IMD_ORACLE.origin+'/oracle/requests/'+requestId}});}
   const proof=await verifyDealOracle({...oracle,maximumWei:v.deal.amount,now:now()}),input=decisionInput(v,oracle,proof);await validateDealDecision(input,pins,now(),{verifyOracle:verifyDealOracle});
   const id='nr_'+digest(input).slice(7);let review;
   if(v.nativeId){requireThat(v.nativeId===id,'native_binding_mismatch');review=await native('/'+id);if(review.state==='missing'||review.state==='queued'&&Date.parse(review.retryAt)<=now())review=await native('',input);}
   else{await checkpoint({nativeId:id,state:'claus-pending'});review=await native('',input);}
   if(review.state==='waiting')return {state:'claus-pending'};
   requireThat(review.id===id&&review.inputHash===digest(input)&&review.proposalHash===input.proposalHash,'native_binding_mismatch');
   if(['failed','blocked'].includes(review.state))return {state:'failed',error:'claus_'+review.state};
   if(review.state!=='completed')return {state:'claus-pending'};
   const decision=review.result;requireThat(decision?.inputHash===digest(input)&&decision.proposalHash===input.proposalHash&&decision.reviewArtifactHash===proof.artifactHash,'native_binding_mismatch');
   if(decision.decision!=='approve')return {state:'blocked',error:'claus_rejected',decisionPublic:decision};
   // Re-read native authority after completion and case authority immediately
   // before the only signing boundary. The key never enters the model/API.
   const current=await native('/'+id);requireThat(current.authorizationActive===true&&canonical(current.result)===canonical(decision)&&await stillAllowed(),'authority_closed');
   await fresh(v);requireThat(input.proposal.expiresAt>Math.floor(now()/1000)+60,'resolution_expired');
   const typed={domain:{name:'ClausDealEscrow',version:'1',chainId:v.chainId,verifyingContract:v.contract},types:RESOLUTION_TYPES,primaryType:'Resolution',message:{dealId:v.dealId,workerAmount:input.proposal.workerAmount,evidenceHash:input.proposal.evidenceHash,expiresAt:input.proposal.expiresAt}};
   await checkpoint({signingIntent:typed,state:'signing'});requireThat(await stillAllowed(),'authority_closed');const signature=await arbiterSigner.signTypedData(typed);requireThat((await recoverTypedDataAddress({...typed,signature})).toLowerCase()===arbiterSigner.address.toLowerCase(),'invalid_arbiter_signature');requireThat(await stillAllowed(),'authority_closed');
   return {state:'resolution-ready',decisionPublic:decision,resolution:{...typed.message,signature,chainId:v.chainId,contract:v.contract,scope:'Only this agreement and its original buyer/provider. Caller submits resolve with its own signer. Issued signatures remain usable until expiry even if API access is later revoked.'}};
  },
  // Read-only reconciliation still runs after authority closes; holds are not erased.
  async reconcile(){for(const row of await store.list('deal-oracle-allocations',{limit:8})){const a=row.value;if(a.billing!=='reserved')continue;const old=await payment.status(a.offer.id);if(!old)continue;try{const state=await payment.reconcile(a.offer.id);await settleCost(a.offer,state,a.inputHash);}catch{}}}
 };
}
