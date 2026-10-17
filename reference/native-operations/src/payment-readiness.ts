import {createPublicClient,http,parseAbi} from 'viem';
import {base} from 'viem/chains';

const payer='0xa46a89b5b3504c1c999696de8173ec9b2eb0a01a';
const usdc='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const permit2='0x000000000022d473030f116ddee9f6b43ac78ba3';
const abi=parseAbi(['function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)']);
const units=(v:unknown)=>typeof v==='string'&&/^(0|[1-9][0-9]{0,77})$/.test(v)?BigInt(v):null;

// This observes the existing fixed payment rail. It cannot approve, transfer,
// settle a request, change its identity or increase an operating allocation.
export function paymentReadiness(value:any,maximumMicroUsdc='2000000'){
 const amount=units(maximumMicroUsdc),cash=units(value?.cashMicroUsdc),allowance=units(value?.allowanceMicroUsdc);
 if(amount===null||amount<=0n||cash===null||allowance===null)return {state:'unknown',ready:false,reason:'payment_rail_unavailable',authorityChanged:false};
 const ready=cash>=amount&&allowance>=amount;
 return {state:ready?'ready':'limited',ready,reason:cash<amount?'payer_cash_insufficient':allowance<amount?'permit2_allowance_required':null,
  maximumMicroUsdc,cashMicroUsdc:String(cash),allowanceMicroUsdc:String(allowance),authorityChanged:false};
}

export async function readPaymentReadiness(maximumMicroUsdc='2000000',createClient:any=createPublicClient){
 for(const url of ['https://mainnet.base.org','https://base-rpc.publicnode.com']){
  try{
   const client=createClient({chain:base,transport:http(url,{timeout:1500,retryCount:0})});
   if(await client.getChainId()!==8453)throw Error('wrong_chain');
   const block=await client.getBlock({blockTag:'latest'});
   if(typeof block.number!=='bigint'||!/^0x[0-9a-f]{64}$/i.test(block.hash??''))throw Error('invalid_block');
   const [cash,allowance]=await Promise.all([
    client.readContract({address:usdc,abi,functionName:'balanceOf',args:[payer],blockNumber:block.number}),
    client.readContract({address:usdc,abi,functionName:'allowance',args:[payer,permit2],blockNumber:block.number})]);
   return {...paymentReadiness({cashMicroUsdc:String(cash),allowanceMicroUsdc:String(allowance)},maximumMicroUsdc),
    observedAt:new Date().toISOString(),chainId:8453,payer,asset:usdc,spender:permit2,blockNumber:String(block.number),blockHash:block.hash};
  }catch{/* An unavailable observation cannot prove the payment rail recovered. */}
 }
 return paymentReadiness(null,maximumMicroUsdc);
}

// Only a terminal, explicitly unsigned failure can start this wait. Unknown
// payments still go through the original reconciliation path before this gate.
export async function unsignedPaymentBlocker(action:any,read=readPaymentReadiness){
 const result=action?.result;
 if(action?.kind!=='inference'||action.status!=='failed'||result?.payment!=='not_signed'||result.failure!=='permit2_allowance_required')return null;
 const requested=units(result.requiredMicroUsdc);
 const value=await read(requested!==null&&requested>0n?String(requested):'2000000');
 return value.ready?null:{originalRequestId:action.id,reason:value.reason??'payment_rail_unavailable',paymentRail:value};
}
