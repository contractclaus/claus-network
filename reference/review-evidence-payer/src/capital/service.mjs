import {keccak256,hashTypedData,encodeFunctionData} from 'viem';
import {PAYER,MANDATE,LIMITS,check,same,digest,context,termsHash,keys} from './policy.mjs';
import {template,observeInvestment,investmentSignature,relayPayload} from './investment.mjs';
import {investmentId} from './store.mjs';
export function investmentService({store,client,account,review,refreshCash,enabled}){
 const adapterHash=keccak256(template.runtimeTemplate);
 async function admit(){check(enabled()&&await store.active(),'mandate_inactive');}
 async function proofFor(input){
  const proof=await review(input);const capital=context(proof.capital);
  check(capital.action!=='launch','investment_only');
  check(same(proof.artifact?.runtimeTemplate,template.runtimeTemplate)&&same(proof.artifact?.creationBytecode,template.creationBytecode),'reviewed_escrow_template');
  return {proof,capital};
 }
 return {
  async overview(){return {enabled:enabled()&&await store.active(),mandate:MANDATE,limits:LIMITS,adapterHash,...await store.overview()};},
  async prepare(input){
   await admit();const {proof,capital}=await proofFor(input);await refreshCash();
   const observed=await observeInvestment(client,capital);investmentSignature(capital,observed);
   const publicProof={reference:proof.reference,reportHash:proof.reportHash,reportArtifactHash:proof.reportArtifactHash,judgeHash:proof.judgeHash,commit:proof.commit};
   const row=await store.reserve({capital,proof:publicProof,decision:input,adapterHash});return {id:row.investment_id,signatureId:row.id,state:row.state,termsHash:termsHash(capital)};
  },
  async advance(input){
   keys(input,['id']);const row=await store.signature(input.id);check(row,'original_missing');
   // Read/reconcile never loads the signing account. Saved signatures are not re-signed.
   await admit();
   const {proof,capital}=await proofFor(row.input.decision);
   check(digest(capital)===digest(row.input.capital)&&proof.reportArtifactHash===row.input.proof.reportArtifactHash&&proof.judgeHash===row.input.proof.judgeHash,'review_changed');
   const observed=await observeInvestment(client,capital);const typed=investmentSignature(capital,observed);
   if(row.signature)return {id:row.id,transaction:relayPayload(capital,row.signature),expiresAt:capital.terms.expiresAt,relay:'The counterparty submits this exact transaction on Base; no wallet key is shared.'};
   check(['reserved','signing'].includes(row.state),'signature_outcome_held');
   const key=account();check(same(key.address,PAYER),'payer_identity');
   if(!await store.claim(row.id,hashTypedData(typed)))return {id:row.id,state:'signing',outcome:'inspect_original'};
   // Crash recovery reproduces only this exact persisted EIP-712 hash and nonce.
   // EIP-3009 and the one-use escrow reject a second economic effect.
   await admit();const signature=await key.signTypedData(typed);await store.save(row.id,signature);
   return {id:row.id,transaction:relayPayload(capital,signature),expiresAt:capital.terms.expiresAt};
  },
  async status(input){keys(input,['id']);const row=await store.get(input.id);check(row,'original_missing');const observed=await observeInvestment(client,row.binding.capital,{finalized:true});
   return {...await store.reconcile(row.id,observed),...(observed.state===1&&observed.timestamp>=row.binding.capital.terms.expiresAt?{refundTransaction:{chainId:8453,to:row.binding.capital.execution.escrow,value:'0',data:encodeFunctionData({abi:template.abi,functionName:'refund'})}}:{})};}
 };
}
