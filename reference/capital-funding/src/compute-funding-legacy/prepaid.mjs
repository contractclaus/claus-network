import {FUNDING as P} from './policy.mjs';
const micro=v=>{if(typeof v!=='string'||!/^\d{1,16}$/.test(v))throw Error('funding_prepaid_amount_invalid');return BigInt(v);};
export function prepaidAllocation({available,pending,minted}){
 const a=micro(available),p=micro(pending),m=micro(minted);
 if(m<=0n||m>BigInt(P.maxGrantPerCycleMicroUsdc))throw Error('funding_prepaid_mint_invalid');
 if(p!==0n)return {state:'waiting_existing_provider_deposit'};
 const need=a<BigInt(P.prepaidLowMicroUsdc)?BigInt(P.prepaidTargetMicroUsdc)-a:0n;
 const amount=[need,m,BigInt(P.prepaidMaxPerCycleMicroUsdc)].reduce((a,b)=>a<b?a:b);
 return {state:'allocated',prepaidMicro:String(amount),cashMicro:String(m-amount),availableMicro:available,mintedMicro:minted};
}
export function validatePrepaidResource({balance,deposit,topup},binding){
 if(binding.address!==P.prepaidAddress||binding.keyId!==P.prepaidKeyId||deposit?.chain_id!==8453||String(deposit?.address).toLowerCase()!==binding.address||String(deposit?.token_address).toLowerCase()!==P.usdc8453||balance?.account_status!=='active'||balance.prefunded_usdc_enabled!==true||topup?.enrolled!==false)throw Error('funding_prepaid_binding_or_status_changed');
 micro(balance.usdc_available_usdc);micro(balance.pending_deposit_usdc);
 if((balance.deposit_address!==undefined&&String(balance.deposit_address).toLowerCase()!==binding.address)||(balance.deposit_chain_id!==undefined&&balance.deposit_chain_id!==8453)||(balance.deposit_token_address!==undefined&&String(balance.deposit_token_address).toLowerCase()!==P.usdc8453))throw Error('funding_prepaid_balance_account_changed');
 if(!Number.isSafeInteger(balance.deposit_min_confirmations)||balance.deposit_min_confirmations<1)throw Error('funding_prepaid_confirmations_unknown');
 return {available:balance.usdc_available_usdc,pending:balance.pending_deposit_usdc,minConfirmations:balance.deposit_min_confirmations};
}
export function validateProviderCredit(credit,receipt,amount,binding){
 if(!credit||credit.provider!=='surplus'||credit.method!=='usdc_deposit'||credit.address!==binding.address||credit.keyId!==binding.keyId||credit.chainId!==8453||credit.token!==P.usdc8453||credit.source!=='https://api.surplusintelligence.ai/v1/payments/history'||typeof credit.id!=='string'||!credit.id.trim()||credit.id.length>256||!/^0x[\da-f]{64}$/i.test(receipt?.transactionHash??'')||credit.transactionHash!==receipt.transactionHash.toLowerCase()||credit.amountMicroUsdc!==amount||micro(amount)<=0n||receipt.finalized!==true||receipt.status!=='success')throw Error('funding_provider_credit_mismatch');
 return credit;
}
// Delivery and provider credit are separate facts. A balance change, a pending
// entry disappearing, or an unrelated credit never completes this operation.
export function prepaidReconciliation(receipt,amount,balance,credit=null,binding={address:P.prepaidAddress,keyId:P.prepaidKeyId}){
 const attributed=credit!==null;
 if(attributed)validateProviderCredit(credit,receipt,amount,binding);
 return {state:attributed?'provider_credit_verified':'waiting_provider_credit_evidence',originalTransaction:receipt.transactionHash,transferredMicroUsdc:amount,chainDeliveryFinalized:receipt.finalized===true,providerCreditAttributed:attributed,observedAvailableMicroUsdc:balance.available,observedPendingMicroUsdc:balance.pending,newCycleAllowed:false,grantApplied:false,...(attributed?{providerCredit:credit}:{})};
}
