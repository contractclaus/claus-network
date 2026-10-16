import {settledFundingContext} from './transactions.mjs';

export const fundingReason=error=>/^(compute_|funding_)[a-z0-9_:]+$/.test(error?.message??'')?error.message:'compute_operation_deferred';

// This path only observes original signed transactions and records their
// canonical outcomes. It never reserves, signs, broadcasts or grants credit.
export async function reconcileFundingOriginals({store,approval,originalReceipt}){
 const originals=await store.unsettledSteps(approval),items=[];
 for(const original of originals){
  try{
   const receipt=await originalReceipt(original);
   if(!receipt?.finalized){items.push({id:original.id,state:'unresolved'});continue;}
   if(receipt.status==='success'){
    await store.confirmStep(original.cycle_id,original.step,receipt,settledFundingContext(original.step,original.context,receipt));
    items.push({id:original.id,state:'confirmed',transactionHash:receipt.transactionHash});
   }else if(receipt.status==='reverted'){
    await store.fail(original.cycle_id,original.step,receipt);
    items.push({id:original.id,state:'reverted',transactionHash:receipt.transactionHash});
   }else throw Error('funding_receipt_status_unknown');
  }catch(error){items.push({id:original.id,state:'deferred',reason:fundingReason(error)});}
 }
 return {checked:items.length,items,automaticTransferMade:false,grantApplied:false};
}

// Provider availability and spending authority gate new effects, not the
// reconciliation of money already sent. Persist failures as current status.
export async function processFunding({reconcile,admit,advance,observe}){
 let recovery;
 try{recovery=await reconcile();}
 catch(error){const result={state:'deferred',reason:fundingReason(error),automaticTransferMade:false};await observe(result);return result;}
 let result;
 try{admit();}
 catch(error){result={state:'authorization_inactive',reason:fundingReason(error),automaticTransferMade:false,recovery};await observe(result);return result;}
 if(recovery.items.some(item=>item.state==='deferred'))result={state:'deferred',reason:'funding_original_recovery_deferred',automaticTransferMade:false,recovery};
 else try{result={...await advance(),recovery};}
 catch(error){result={state:'deferred',reason:fundingReason(error),recovery};}
 await observe(result);return result;
}
