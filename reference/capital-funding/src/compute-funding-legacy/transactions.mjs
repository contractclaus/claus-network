import {createRequire} from 'node:module';
import {FUNDING as P} from './policy.mjs';
const {encodeFunctionData,parseAbi,decodeEventLog,padHex,keccak256}=createRequire(import.meta.url)('viem');
const abi=parseAbi([
 'function claimActive(uint256 amount)',
 'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns(uint256 amountOut)',
 'function approve(address spender,uint256 amount) returns(bool)',
 'function depositForBurn(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold)',
 'function receiveMessage(bytes message,bytes attestation) returns(bool)',
 'function transfer(address to,uint256 amount) returns(bool)',
 'event Transfer(address indexed from,address indexed to,uint256 value)',
 'event MessageSent(bytes message)'
]);
const call=(chainId,from,to,functionName,args,value='0')=>({chainId,from,to,data:encodeFunctionData({abi,functionName,args}),value});
const positive=(n,max)=>{n=BigInt(n);if(n<=0n||n>BigInt(max))throw Error('funding_amount_out_of_bounds');return n;};
export function fundingTransaction(step,context) {
 const amount=positive(context.claimWei,P.claimPerCycleWei);
 if(step==='claim')return call(1,P.beneficiary,P.revenue,'claimActive',[amount]);
 if(step==='swap'){
  if(!Number.isSafeInteger(context.deadline)||BigInt(context.minimumOut)<BigInt(P.minimumSwapMicroUsdc))throw Error('funding_quote_required');
  return call(1,P.beneficiary,P.router,'exactInputSingle',[{tokenIn:P.weth,tokenOut:P.usdc1,fee:P.fee,recipient:P.beneficiary,deadline:BigInt(context.deadline),amountIn:amount,amountOutMinimum:BigInt(context.minimumOut),sqrtPriceLimitX96:0n}],String(amount));
 }
 const usdc=positive(context.swapReceivedMicro,P.maxGrantPerCycleMicroUsdc);
 if(step==='prepaid'){
  const allocated=positive(context.prepaidMicro,P.prepaidMaxPerCycleMicroUsdc);
  if(context.providerAddress!==P.prepaidAddress||allocated>positive(context.mintedMicro,usdc))throw Error('funding_prepaid_binding_changed');
  return call(8453,P.payer,P.usdc8453,'transfer',[P.prepaidAddress,allocated]);
 }
 if(step==='approve')return call(1,P.beneficiary,P.usdc1,'approve',[P.messenger,usdc]);
 if(step==='burn')return call(1,P.beneficiary,P.messenger,'depositForBurn',[usdc,P.destinationDomain,padHex(P.payer,{size:32}),P.usdc1,padHex(P.payer,{size:32}),BigInt(P.maxBridgeFeeMicroUsdc),P.finality]);
 if(step==='receive'){
  if(!/^0x[0-9a-f]+$/i.test(context.message??'')||!/^0x[0-9a-f]+$/i.test(context.attestation??'')||keccak256(context.message)!==context.originalMessageHash)throw Error('funding_original_message_required');
  validateAttestedMessage(context.message,context.attestedMessage);
  return call(8453,P.payer,P.transmitter,'receiveMessage',[context.attestedMessage,context.attestation]);
 }
 throw Error('funding_step_not_allowed');
}
export function receivedUsdc(receipt,chainId,to,from){
 if(receipt?.status!=='success')throw Error('funding_transaction_not_successful');
 const token=chainId===1?P.usdc1:chainId===8453?P.usdc8453:null;if(!token)throw Error('funding_chain');
 let total=0n;
 for(const log of receipt.logs??[]){if(log.address.toLowerCase()!==token)continue;let e;try{e=decodeEventLog({abi,data:log.data,topics:log.topics});}catch{continue;}if(e.eventName==='Transfer'&&e.args.to.toLowerCase()===to.toLowerCase()&&(!from||e.args.from.toLowerCase()===from.toLowerCase()))total+=e.args.value;}
 if(total<=0n)throw Error('funding_transfer_receipt_missing');return String(total);
}
export function originalBurnMessage(receipt){
 const messages=[];for(const log of receipt.logs??[]){if(log.address.toLowerCase()!==P.transmitter)continue;try{const e=decodeEventLog({abi,data:log.data,topics:log.topics});if(e.eventName==='MessageSent')messages.push(e.args.message);}catch{}}
 if(messages.length!==1)throw Error('funding_original_burn_message_missing');
 return {message:messages[0],originalMessageHash:keccak256(messages[0])};
}
export function settledFundingContext(step,original,receipt){
 const context={...original};
 if(step==='swap')context.swapReceivedMicro=receivedUsdc(receipt,1,P.beneficiary);
 if(step==='burn')Object.assign(context,originalBurnMessage(receipt),{burnTransaction:receipt.transactionHash});
 if(step==='receive')Object.assign(context,{mintedMicro:receivedUsdc(receipt,8453,P.payer,'0x0000000000000000000000000000000000000000'),fundingTransaction:receipt.transactionHash});
 if(step==='prepaid'&&receivedUsdc(receipt,8453,P.prepaidAddress,P.payer)!==context.prepaidMicro)throw Error('funding_prepaid_transfer_mismatch');
 return context;
}
// CCTP V2 assigns nonce/finality/fee/expiration offchain. Compare all immutable
// bytes to the original onchain MessageSent, not the two whole-message hashes.
export function validateAttestedMessage(original,attested){
 if(!/^0x[0-9a-f]{752}$/i.test(original??'')||!/^0x[0-9a-f]{752}$/i.test(attested??''))throw Error('funding_cctp_message_shape');
 const a=Buffer.from(original.slice(2),'hex'),b=Buffer.from(attested.slice(2),'hex');
 for(const [start,end] of [[0,12],[44,144],[148,312]])if(!a.subarray(start,end).equals(b.subarray(start,end)))throw Error('funding_cctp_message_changed');
 const uint=(start,end)=>BigInt('0x'+b.subarray(start,end).toString('hex'));
 if(uint(0,4)!==1n||uint(4,8)!==0n||uint(8,12)!==6n||uint(12,44)===0n||uint(140,144)!==2000n||uint(144,148)<2000n||uint(312,344)>uint(280,312)||uint(280,312)>BigInt(P.maxBridgeFeeMicroUsdc))throw Error('funding_cctp_message_bounds');
 const address=(start)=>'0x'+b.subarray(start+12,start+32).toString('hex');
 if(address(44)!==P.messenger||address(76)!==P.messenger||address(108)!==P.payer||address(152)!==P.usdc1||address(184)!==P.payer||address(248)!==P.beneficiary)throw Error('funding_cctp_recipient_changed');
 return {feeMicroUsdc:String(uint(312,344)),expirationBlock:String(uint(344,376))};
}
