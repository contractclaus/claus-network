import {createHash} from 'node:crypto';
export const FUNDING=Object.freeze({
 version:5,id:'claus-capital-compute-v1',enabled:true,rail:'x402-wallet',
 lowWalletMicroUsdc:'10000000',
 // Historical prepaid coordinates remain for receipt validation only; wallet funding never sends there.
 prepaidAddress:'0x74a67657afabb38fdc033d1f06c5cae11449ccda',
 prepaidKeyId:'01M4K34S82WJSM6JXG4F29MMZC',
 prepaidLowMicroUsdc:'10000000',prepaidTargetMicroUsdc:'50000000',prepaidMaxPerCycleMicroUsdc:'50000000',
 revenue:'0x3dc1183ff95889359e00987b55d9164aad306762',
 beneficiary:'0xbb145ca83272c3806d4ddc75ca1d5514789cf1c5',
 payer:'0xa46a89b5b3504c1c999696de8173ec9b2eb0a01a',
 weth:'0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
 usdc1:'0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
 usdc8453:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
 router:'0xe592427a0aece92de3edee1f18e0157c05861564',
 quoter:'0xb27308f9f90d607463bb33ea1bebb41c27ce5ab6',
 messenger:'0x28b5a0e9c621a5badaa536219b3a228c8168cf5d',
 transmitter:'0x81d40f21f12a8f0e3252bccb954d722d4c464b64',
 fee:500,sourceDomain:0,destinationDomain:6,finality:2000,
 claimPerCycleWei:'20000000000000000',claimTotalWei:'200000000000000000',
 l1GasPerCycleWei:'1000000000000000',baseGasPerCycleWei:'100000000000000',
 minimumSwapMicroUsdc:'40000000',maxBridgeFeeMicroUsdc:'100000',
 durableCapital:true,maxGrantPerCycleMicroUsdc:'100000000',cycleIntervalSeconds:86400,
 lowAuthorityMicroUsdc:'10000000',quoteValiditySeconds:120,slippageBps:50,
 preserveTreasuryPips:12000,computePips:1000,combinedOwnerPips:13000,minimumOwnerBalanceWei:'900000000000000000',changeTreasury:false,changeLpFees:false
});
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
export const fundingHash=value=>createHash('sha256').update(canonical(value)).digest('hex');
export function validateFundingApproval(approval,{now=Date.now(),binding}={}){
 if(!approval||approval.authorized!==true||approval.action!=='activate-compute-operating-funding'||approval.policyHash!==fundingHash(FUNDING)||approval.providerAddress!==binding?.address||approval.providerKeyId!==binding?.keyId||!Number.isSafeInteger(approval.startsAt)||approval.duration!=='until_owner_revocation'||approval.capitalPolicyHash!=='a21b0e70568a888cdb95126b35c57f3b310ada00962a008ff76273ad13adc59c'||now<approval.startsAt)throw Error('funding_explicit_bounded_approval_required');
 return approval;
}
