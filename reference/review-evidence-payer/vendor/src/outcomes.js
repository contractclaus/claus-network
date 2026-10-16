import { createPublicClient, parseAbi, decodeFunctionData } from 'viem';
import { PERMIT2_ADDRESS, x402UptoPermit2ProxyAddress, x402UptoPermit2ProxyABI } from '@x402/evm';
import { address, usdc } from './policy.js';
import { inferenceRpc } from './inference-rpc.js';

const abi=parseAbi(['function authorizationState(address authorizer, bytes32 nonce) view returns (bool)','event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)','event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)']);
const client=createPublicClient({transport:inferenceRpc(process.env.BASE_RPC_URL)});
async function firstBlockAt(timestamp,head,chain,cache) {
  if(timestamp>head.timestamp)return head.number+1n;
  // Recent payments must not probe pruned genesis-era history. Widen a
  // bracket backwards from the safe head, then keep the exact lower-bound
  // search. A missing required block still throws and retains the hold.
  const blockAt=async number=>{
    let block=cache.get(number);
    if(!block){block=await chain.getBlock({blockNumber:number});cache.set(number,block);}
    return block;
  };
  let low=head.number,high=head.number,span=1024n;
  while(low>0n){
    const probe=span>=head.number?0n:head.number-span;
    const block=await blockAt(probe);
    if(block.timestamp<timestamp){low=probe+1n;break;}
    high=probe;low=probe;span*=2n;
  }
  while(low<high) {
    const mid=(low+high)/2n;
    const b=await blockAt(mid);
    if(b.timestamp<timestamp)low=mid+1n;else high=mid;
  }
  return low;
}

// Inference has one external effect: its capped USDC payment. Function-tool
// proposals in a lost model response were never executed by this service.
// Use L1-derived safe state, retain its confirmation level, and never resend.
export async function paymentOutcome(payment,previous={},chain=client,expectedPayer=address) {
  if(payment?.accepted?.scheme==='upto')return uptoOutcome(payment,previous,chain,expectedPayer);
  const a=payment?.payload?.authorization;
  if(!a||a.from?.toLowerCase()!==expectedPayer.toLowerCase()||!/^0x[0-9a-fA-F]{64}$/.test(a.nonce)||!/^\d+$/.test(String(a.validBefore)))return null;
  const block=await chain.getBlock({blockTag:'safe'});
  if(block.timestamp<=BigInt(a.validBefore))return null;
  const used=await chain.readContract({address:usdc,abi,functionName:'authorizationState',args:[a.from,a.nonce],blockNumber:block.number});
  const proof={network:'eip155:8453',confirmation:'safe',blockNumber:String(block.number),blockHash:block.hash,blockTimestamp:String(block.timestamp),authorizationExpired:true,authorizationUsed:used};
  if(!used)return {...previous,payment:'not_settled',authorizedMicroUsdc:String(a.value),proof};
  // A consumed nonce may mean cancellation. An event and successful receipt
  // distinguish that from payment; authorizationState alone cannot do so.
  // This client creates signatures with <=120 seconds of validity. Search
  // around that deadline, even after long downtime, within RPC range limits.
  // Evidence outside this window stays unresolved rather than being guessed.
  const expiry=BigInt(a.validBefore),cache=new Map([[block.number,block]]);
  const from=await firstBlockAt(expiry>600n?expiry-600n:0n,block,chain,cache);
  const to=(await firstBlockAt(expiry+600n,block,chain,cache))-1n;
  if(from>to)return null;
  for(const [event,paymentStatus] of [[abi[1],'settled'],[abi[2],'not_settled']]) {
    const logs=await chain.getLogs({address:usdc,event,args:{authorizer:a.from,nonce:a.nonce},fromBlock:from,toBlock:to});
    for(const log of logs) {
      const receipt=await chain.getTransactionReceipt({hash:log.transactionHash});
      if(receipt.status!=='success'||receipt.blockHash!==log.blockHash||receipt.blockNumber<from||receipt.blockNumber>to)continue;
      return {...previous,...(!previous.providerResponseReceived?{failure:'model_response_lost'}:{}),payment:paymentStatus,authorizedMicroUsdc:String(a.value),proof:{...proof,authorizationCancelled:event.name==='AuthorizationCanceled',transaction:log.transactionHash,transactionBlockNumber:String(receipt.blockNumber)}};
    }
  }
  return null;
}

const permitAbi=parseAbi(['function nonceBitmap(address,uint256) view returns (uint256)']);
const transfer=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)'])[0];
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const uint=v=>/^\d{1,78}$/.test(String(v))&&BigInt(v)<2n**256n;

async function uptoOutcome(payment,previous,chain,expectedPayer) {
  const a=payment.payload?.permit2Authorization;
  if(!a||!same(a.from,expectedPayer)||!same(a.permitted?.token,usdc)||!same(a.spender,x402UptoPermit2ProxyAddress)||![a.nonce,a.deadline,a.permitted.amount].every(uint))return null;
  const block=await chain.getBlock({blockTag:'safe'}),expiry=BigInt(a.deadline);
  if(block.timestamp<=expiry)return null;
  const nonce=BigInt(a.nonce),word=nonce>>8n,mask=1n<<(nonce&255n);
  const bitmap=await chain.readContract({address:PERMIT2_ADDRESS,abi:permitAbi,functionName:'nonceBitmap',args:[a.from,word],blockNumber:block.number});
  const used=(bitmap&mask)!==0n;
  const proof={network:'eip155:8453',scheme:'upto',confirmation:'safe',blockNumber:String(block.number),blockHash:block.hash,blockTimestamp:String(block.timestamp),authorizationExpired:true,authorizationUsed:used};
  const result={...previous,authorizedMicroUsdc:String(a.permitted.amount),proof};
  if(!used)return {...result,payment:'not_settled'};
  // Permit2 nonce consumption alone is not payment evidence. Match the
  // actual proxy call, full authorization, transfer and canonical receipt.
  const cache=new Map([[block.number,block]]);
  const from=await firstBlockAt(expiry>600n?expiry-600n:0n,block,chain,cache);
  const to=(await firstBlockAt(expiry+600n,block,chain,cache))-1n;
  if(from>to)return null;
  const transfers=await chain.getLogs({address:usdc,event:transfer,args:{from:a.from,to:a.witness.to},fromBlock:from,toBlock:to});
  for(const log of transfers) {
    const tx=await chain.getTransaction({hash:log.transactionHash});
    if(!same(tx.to,x402UptoPermit2ProxyAddress)||tx.blockHash!==log.blockHash)continue;
    let call;
    try {call=decodeFunctionData({abi:x402UptoPermit2ProxyABI,data:tx.input});}catch {continue;}
    if(!['settle','settleWithPermit'].includes(call.functionName))continue;
    const [permit,amount,owner,witness,signature]=call.args.slice(call.functionName==='settleWithPermit'?1:0);
    if(!same(owner,a.from)||!same(permit.permitted.token,a.permitted.token)||permit.permitted.amount!==BigInt(a.permitted.amount)||permit.nonce!==nonce||permit.deadline!==expiry||!same(witness.to,a.witness.to)||!same(witness.facilitator,a.witness.facilitator)||witness.validAfter!==BigInt(a.witness.validAfter)||signature!==payment.payload.signature||amount>BigInt(a.permitted.amount)||log.args.value!==amount)continue;
    const receipt=await chain.getTransactionReceipt({hash:log.transactionHash});
    if(receipt.status!=='success'||receipt.blockHash!==log.blockHash||receipt.blockNumber<from||receipt.blockNumber>to)continue;
    return {...result,...(!previous.providerResponseReceived?{failure:'model_response_lost'}:{}),payment:'settled',settledMicroUsdc:String(amount),proof:{...proof,transaction:log.transactionHash,transactionBlockNumber:String(receipt.blockNumber)}};
  }
  // A cancelled nonce or settlement through an unrecognized wrapper stays
  // unresolved. Never infer payment or safely retry from the bitmap alone.
  return null;
}

export function providerFailure(response,result,payment) {
  const code=result?.error?.code??result?.error?.type;
  const message=typeof result?.error?.message==='string'?result.error.message:'';
  const parameter=['max_tokens','max_completion_tokens','reasoning_effort','parallel_tool_calls','tool_choice','tools','model','input_images','image_url','aspect_ratio','resolution','quality','response_format','base64','image'].find(p=>new RegExp(`\\b${p}\\b`).test(message));
  // Preserve machine-readable rejection reasons, never the raw upstream body
  // or message, which may echo authorization/signature or private request data.
  const machineReason=[result?.invalidReason,result?.verification?.invalidReason,result?.error?.invalidReason,result?.error?.details?.invalidReason,result?.error?.reason,result?.details?.invalidReason]
    .find(v=>typeof v==='string'&&/^(invalid_|insufficient_|unsupported_|payment_|authorization_|facilitator_|network_|resource_|accepted_|signature_)[a-z0-9_:-]{1,90}$/.test(v));
  const reason=machineReason??['unsupported_parameter','unsupported_value','model_not_found','invalid_signature','insufficient_funds'].find(p=>message.includes(p))
    ??message.match(/\b((?:invalid_|insufficient_|unsupported_|payment_|authorization_|facilitator_|network_|resource_|accepted_|signature_)[a-z0-9_:-]{1,90})\b/)?.[1];
  let changedQuote={};
  if(response.status===402&&payment?.accepted) {
    try {
      const encoded=response.headers?.get('payment-required');
      const challenge=encoded?JSON.parse(Buffer.from(encoded,'base64').toString()):result;
      const a=payment.accepted,b=challenge.accepts?.find(r=>r.scheme===a.scheme&&r.network===a.network&&r.asset?.toLowerCase()===a.asset.toLowerCase());
      if(b&&/^\d{1,20}$/.test(b.amount))changedQuote={rejectedQuoteMicroUsdc:b.amount,quoteAmountChanged:b.amount!==a.amount,quoteRecipientChanged:b.payTo?.toLowerCase()!==a.payTo.toLowerCase()};
    } catch { /* Only sanitized comparison metadata is retained. */ }
  }
  const requestId=response.headers?.get('x-request-id');
  const attempts=(response.headers?.get('x-si-attempts')??'').slice(0,4096).split(',').flatMap(value=>{
    const match=value.trim().match(/^(openai|openrouter|venice|google|anthropic|unknown):[a-zA-Z0-9_-]{1,80}:(unavailable|rate_limited|not_found|upstream_error|request_rejected|timeout|error)$/);
    return match?[{provider:match[1],reason:match[2]}]:[];
  }).slice(0,16);
  return {failure:'provider_response_invalid',providerResponseReceived:true,httpStatus:response.status,...(typeof code==='string'&&/^[a-zA-Z0-9_:-]{1,100}$/.test(code)?{providerCode:code}:{}),...(parameter?{providerParameter:parameter}:{}),...(reason?{providerReason:reason}:{}),...(typeof requestId==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(requestId)?{providerRequestId:requestId}:{}),...(attempts.length?{providerAttempts:attempts}:{}),...changedQuote};
}
