import {FUNDING as P,fundingHash,validateFundingApproval} from './policy.mjs';
import {fundingTransaction,receivedUsdc,settledFundingContext} from './transactions.mjs';
import {prepaidAllocation,prepaidReconciliation} from './prepaid.mjs';
import {findProviderCredit} from './provider-credit.mjs';
// Ports expose only pinned reads and an original-transaction executor. No
// caller-supplied address, calldata, signature or receipt can enter this loop.
export async function advanceFunding({store,ports,approval,binding,now=Date.now}){
 validateFundingApproval(approval,{now:now(),binding});
 const resources=await ports.resources();
 const walletOnly=P.rail==='x402-wallet';
 if(walletOnly){if(resources.walletAddress!==P.payer||resources.chainId!==8453||!/^\d+$/.test(resources.walletUsdcMicro))throw Error('funding_wallet_binding_changed');}
 else if(resources.providerBinding.address!==binding.address||resources.providerBinding.keyId!==binding.keyId||resources.providerAutoTopup!==false)throw Error('funding_provider_binding_changed');
 let cycle=await store.active();
 if(!cycle){
  if(!walletOnly&&BigInt(resources.prepaid.pending)!==0n)return {state:'waiting_existing_provider_deposit',automaticTransferMade:false};
  if(walletOnly?BigInt(resources.walletUsdcMicro)>=BigInt(resources.cashThresholdMicroUsdc):BigInt(resources.prepaid.available)>=BigInt(P.prepaidLowMicroUsdc))return {state:'not_needed',automaticTransferMade:false,...(walletOnly?{fundingRail:'base-usdc-wallet',walletAddress:P.payer,chainId:8453,walletUsdcMicro:resources.walletUsdcMicro,remainingAuthorityMicroUsdc:resources.remainingAuthorityMicroUsdc}:{})};
  if(resources.sourceFinalized===false)return {state:'waiting_initial_source_finality',automaticTransferMade:false};
  if(BigInt(resources.claimableActiveWei)<BigInt(P.claimPerCycleWei))return {state:'insufficient_earned_revenue',automaticTransferMade:false};
  cycle=await store.reserve({approval,policyHash:fundingHash(P),claimWei:P.claimPerCycleWei,now:now(),providerAddress:binding.address});
 }
 if(!cycle.id.startsWith(P.id+':'))throw Error('funding_original_policy_mismatch');
 const context={...cycle.context,claimWei:cycle.claimWei,providerAddress:binding.address};
 for(const step of ['claim','swap','approve','burn','receive']){
  let original=await store.step(cycle.id,step);
  if(original?.state==='confirmed'){Object.assign(context,original.context);continue;}
  if(step==='swap'&&!original){
   const quote=await ports.quote(context.claimWei);
   if(quote.observedAt>now()||now()-quote.observedAt>P.quoteValiditySeconds*1000||BigInt(quote.amountOut)<BigInt(P.minimumSwapMicroUsdc))throw Error('funding_quote_stale_or_below_floor');
   context.minimumOut=String(BigInt(quote.amountOut)*BigInt(10000-P.slippageBps)/10000n);context.deadline=Math.floor(now()/1000)+P.quoteValiditySeconds;
  }
  if(step==='receive'){
   const attestation=await ports.attestation(context.message,context.originalMessageHash,context.burnTransaction);
   if(!attestation)return {state:'waiting_original_attestation',id:cycle.id};
   context.attestation=attestation.attestation;context.attestedMessage=attestation.message;
  }
  if(!original){
   const transaction=fundingTransaction(step,context);
   original=await store.reserveStep(cycle.id,step,{transaction,context});
  }
  // The executor recovers original signed bytes/nonces, holds ambiguous sends
  // and enforces cumulative gas. It never signs a replacement transaction.
  const receipt=await ports.originalTransaction(original.id,original.transaction,{cycleId:cycle.id,step,l1GasCap:P.l1GasPerCycleWei,baseGasCap:P.baseGasPerCycleWei});
  if(!receipt?.finalized)return {state:'waiting_original_transaction',id:cycle.id,step,originalId:original.id};
  if(receipt.status!=='success'){await store.fail(cycle.id,step,receipt);return {state:'failed_original_transaction',id:cycle.id,step};}
  Object.assign(context,settledFundingContext(step,context,receipt));
  await store.confirmStep(cycle.id,step,receipt,context);
  // One original chain action per call: a normal existing cycle can advance
  // it; this implementation neither creates a cron nor dispatches extra work.
  return {state:'advanced',id:cycle.id,step};
 }
 const original=await store.step(cycle.id,'receive');
 const receipt=original.receipt?.finalized?original.receipt:await ports.originalTransaction(original.id,original.transaction,{cycleId:cycle.id,step:'receive',l1GasCap:P.l1GasPerCycleWei,baseGasCap:P.baseGasPerCycleWei});
 if(!receipt?.finalized||receipt.status!=='success')return {state:'waiting_original_mint_receipt',id:cycle.id};
 const amount=receivedUsdc(receipt,8453,P.payer,'0x0000000000000000000000000000000000000000');
 if(amount!==context.mintedMicro)throw Error('funding_mint_receipt_changed');
 let allocation=await store.allocation(cycle.id);
 if(!allocation){
  const candidate=walletOnly?{state:'allocated',prepaidMicro:'0',cashMicro:amount,mintedMicro:amount}:prepaidAllocation({...resources.prepaid,minted:amount});
  if(candidate.state!=='allocated')return {...candidate,id:cycle.id};
  allocation=await store.reserveAllocation(cycle.id,candidate);
 }
 if(walletOnly&&allocation.prepaidMicro!=='0')throw Error('funding_original_allocation_not_wallet');
 if(allocation.prepaidMicro!=='0'){
  Object.assign(context,{prepaidMicro:allocation.prepaidMicro});
  let deposit=await store.step(cycle.id,'prepaid');
  const previous=cycle.context.prepaidReconciliation;
  if(previous?.nextReadAt>now())return {state:'waiting_provider_credit_evidence',id:cycle.id,reason:previous.reason,nextReadAt:previous.nextReadAt,automaticTransferMade:false,grantApplied:false};
  const history=await ports.prepaidHistory(previous?.cursor??null);
  if(history.state!=='available'){
   await store.observePrepaid(cycle.id,history);
   return {state:'waiting_provider_credit_evidence',id:cycle.id,reason:history.reason,nextReadAt:history.nextReadAt,automaticTransferMade:false,grantApplied:false};
  }
  // Do not send a new prepaid deposit when the provider's ledger cannot even
  // be read. Existing deposits keep their original ID and stay held.
  if(!deposit)deposit=await store.reserveStep(cycle.id,'prepaid',{transaction:fundingTransaction('prepaid',context),context});
  const paid=deposit.receipt?.finalized?deposit.receipt:await ports.originalTransaction(deposit.id,deposit.transaction,{cycleId:cycle.id,step:'prepaid',l1GasCap:P.l1GasPerCycleWei,baseGasCap:P.baseGasPerCycleWei});
  if(!paid?.finalized)return {state:'waiting_original_transaction',id:cycle.id,step:'prepaid',originalId:deposit.id};
  if(paid.status!=='success'){await store.fail(cycle.id,'prepaid',paid);return {state:'failed_original_transaction',id:cycle.id,step:'prepaid'};}
  if(receivedUsdc(paid,8453,P.prepaidAddress,P.payer)!==allocation.prepaidMicro)throw Error('funding_prepaid_transfer_mismatch');
  await store.confirmStep(cycle.id,'prepaid',paid,context);
  const match=findProviderCredit(history,paid,allocation.prepaidMicro,binding);
  if(match.state!=='credited'){
   const observation={state:'waiting',reason:match.reason,requestId:history.requestId,observedAt:history.observedAt,cursor:history.nextCursor,nextReadAt:now()+300000};
   await store.observePrepaid(cycle.id,observation);
   return {...prepaidReconciliation(paid,allocation.prepaidMicro,resources.prepaid),id:cycle.id,reason:match.reason,nextReadAt:observation.nextReadAt};
  }
  const verified=prepaidReconciliation(paid,allocation.prepaidMicro,resources.prepaid,match.credit,binding);
  await store.creditAndGrant(cycle.id,{deposit:{state:'credited',transactionHash:receipt.transactionHash,address:P.payer,chainId:8453,rail:'x402-and-prepaid',receipt,providerCredit:verified.providerCredit,prepaidReceipt:paid},amountMicroUsdc:amount});
  return {state:'completed',id:cycle.id,source:'settled_earned_revenue',rail:'x402-and-prepaid',originalFundingTransaction:receipt.transactionHash,originalPrepaidTransaction:paid.transactionHash,providerCreditId:match.credit.id};
 }
 await store.creditAndGrant(cycle.id,{deposit:{state:'credited',transactionHash:receipt.transactionHash,address:P.payer,chainId:8453,rail:'x402',receipt},amountMicroUsdc:amount});
 return {state:'completed',id:cycle.id,source:'settled_earned_revenue',rail:'x402',originalFundingTransaction:receipt.transactionHash};
}
