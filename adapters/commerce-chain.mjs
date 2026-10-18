import {createPublicClient,decodeEventLog,encodeFunctionData,fallback,http,parseAbi} from 'viem';
import {base} from 'viem/chains';

export const USDC='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const TOKEN_ABI=parseAbi([
 'function transfer(address to,uint256 value) returns (bool)',
 'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)',
 'function authorizationState(address authorizer,bytes32 nonce) view returns (bool)',
 'event Transfer(address indexed from,address indexed to,uint256 value)',
 'event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)'
]);
export const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
export const address=v=>typeof v==='string'&&/^0x[0-9a-fA-F]{40}$/.test(v)&&!/^0x0{40}$/.test(v);
export function transferData(to,value){return encodeFunctionData({abi:TOKEN_ABI,functionName:'transfer',args:[to,BigInt(value)]});}
export function refundData(a){const s=a.signature.slice(2);return encodeFunctionData({abi:TOKEN_ABI,functionName:'transferWithAuthorization',args:[a.message.from,a.message.to,BigInt(a.message.value),BigInt(a.message.validAfter),BigInt(a.message.validBefore),a.message.nonce,Number.parseInt(s.slice(128,130),16),'0x'+s.slice(0,64),'0x'+s.slice(64,128)]});}
export function commerceChain({client=createPublicClient({chain:base,transport:fallback([http('https://mainnet.base.org',{timeout:8000,retryCount:0}),http('https://base-rpc.publicnode.com',{timeout:8000,retryCount:0})],{retryCount:0})})}={}){
 async function receipt(hash){
  if(!/^0x[0-9a-fA-F]{64}$/.test(hash??''))throw Object.assign(Error('invalid_transaction'),{code:'invalid_transaction'});
  let r;try{r=await client.getTransactionReceipt({hash});}catch(e){if(/TransactionReceiptNotFound|TransactionNotFound/.test(e.name))return {state:'pending'};throw Object.assign(Error('commerce_chain_unavailable'),{code:'commerce_chain_unavailable'});}
  if(r.status!=='success')return {state:'invalid',reason:'transaction_reverted'};
  const [safe,block,transaction,chainId]=await Promise.all([client.getBlock({blockTag:'safe'}),client.getBlock({blockNumber:r.blockNumber}),client.getTransaction({hash}),client.getChainId()]);
  if(chainId!==8453)throw Object.assign(Error('commerce_chain_unavailable'),{code:'commerce_chain_unavailable'});
  if(!same(r.transactionHash,hash)||!same(transaction.hash,hash))throw Object.assign(Error('commerce_chain_unavailable'),{code:'commerce_chain_unavailable'});
  if(!same(block.hash,r.blockHash)||!same(transaction.blockHash,r.blockHash))return {state:'pending'};
  if(safe.number<r.blockNumber)return {state:'pending'};
  return {state:'confirmed',r,transaction,block,proof:{network:'eip155:8453',asset:USDC,transaction:hash.toLowerCase(),blockNumber:r.blockNumber.toString(),blockHash:r.blockHash,blockTime:Number(block.timestamp)*1000,confirmation:'safe'}};
 }
 function transfers(r){return r.logs.filter(l=>same(l.address,USDC)).flatMap(l=>{try{const e=decodeEventLog({abi:TOKEN_ABI,data:l.data,topics:l.topics,strict:true});return e.eventName==='Transfer'?[e.args]:[];}catch{return [];}});}
 return {
  async payment(hash,{from,to,amountMicroUsdc,notBefore=0}){
   const v=await receipt(hash);if(v.state!=='confirmed')return v;
   const ts=transfers(v.r),expected=transferData(to,amountMicroUsdc);
   if(!same(v.transaction.from,from)||!same(v.transaction.to,USDC)||!same(v.transaction.input,expected)||v.proof.blockTime<notBefore||ts.length!==1||!same(ts[0].from,from)||!same(ts[0].to,to)||ts[0].value!==BigInt(amountMicroUsdc))return {state:'invalid',reason:'payment_does_not_match_invoice'};
   return {...v.proof,state:'confirmed',from:from.toLowerCase(),to:to.toLowerCase(),amountMicroUsdc};
  },
  async settlement(hash,authorization){
   const v=await receipt(hash);if(v.state!=='confirmed')return v;const m=authorization.message,ts=transfers(v.r);
   const used=v.r.logs.some(l=>{try{const e=decodeEventLog({abi:TOKEN_ABI,data:l.data,topics:l.topics,strict:true});return same(l.address,USDC)&&e.eventName==='AuthorizationUsed'&&same(e.args.authorizer,m.from)&&same(e.args.nonce,m.nonce);}catch{return false;}});
   if(!same(v.transaction.to,USDC)||!same(v.transaction.input,refundData(authorization))||!used||ts.length!==1||!same(ts[0].from,m.from)||!same(ts[0].to,m.to)||ts[0].value!==BigInt(m.value))return {state:'invalid',reason:'settlement_does_not_match_authorization'};
   return {...v.proof,state:'confirmed',from:m.from,to:m.to,amountMicroUsdc:m.value};
  }
 };
}
