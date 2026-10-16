import {createRequire} from 'node:module';
import {FUNDING as P,fundingHash} from './policy.mjs';
import {validateAttestedMessage} from './transactions.mjs';
const {parseAbi,keccak256}=createRequire(import.meta.url)('viem');
const abi=parseAbi(['function active() view returns(address)','function balances() view returns(uint256 activeAmount,uint256 treasuryAmount)','function balanceOf(address) view returns(uint256)','function quoteExactInputSingle(address tokenIn,address tokenOut,uint24 fee,uint256 amountIn,uint160 sqrtPriceLimitX96) returns(uint256)']);
export function fundingReadPorts({clients,paymentPool,binding,providerResourceRead,originalTransaction,contractPins,request=fetch,now=Date.now}){
 async function verifyPins(){
  for(const chain of [1,8453])for(const [address,pin] of Object.entries(contractPins[chain]??{})){
   const code=await clients[chain].getCode({address});if(!code||keccak256(code)!==pin.codeHash)throw Error('funding_contract_code_changed');
   for(const implementation of pin.implementations??[]){const value=await clients[chain].getStorageAt({address,slot:implementation.slot});if(value!==implementation.value)throw Error('funding_contract_implementation_changed');const code=await clients[chain].getCode({address:implementation.address});if(!code||keccak256(code)!==implementation.codeHash)throw Error('funding_implementation_code_changed');}
  }
  for(const [chain,addresses] of [[1,[P.revenue,P.router,P.quoter,P.messenger,P.transmitter,P.usdc1]],[8453,[P.transmitter,P.usdc8453]]])for(const address of addresses)if(!contractPins[chain]?.[address])throw Error('funding_contract_pin_missing');
 }
 return {
  originalTransaction,verifyPins,
  async resources(){
   await verifyPins();
   const chain=clients[1],block=await chain.getBlock({blockTag:'finalized'});
   const sourceCode=await chain.getCode({address:P.revenue,blockNumber:block.number});
   const sourceFinalized=!!sourceCode&&sourceCode!=='0x';
   const [active,balances,resource,budget]=await Promise.all([
    sourceFinalized?chain.readContract({address:P.revenue,abi,functionName:'active',blockNumber:block.number}):P.beneficiary,
    sourceFinalized?chain.readContract({address:P.revenue,abi,functionName:'balances',blockNumber:block.number}):[0n,0n],
    P.rail==='x402-wallet'?clients[8453].readContract({address:P.usdc8453,abi,functionName:'balanceOf',args:[P.payer]}):providerResourceRead(),
    paymentPool.query('SELECT ceiling::text,committed::text FROM claus_payment_budget WHERE id=true')
   ]);
   if(active.toLowerCase()!==P.beneficiary||!budget.rows[0])throw Error('funding_source_or_budget_changed');
   const shared={sourceFinalized,claimableActiveWei:String(balances[0]),remainingAuthorityMicroUsdc:String(BigInt(budget.rows[0].ceiling)-BigInt(budget.rows[0].committed)),sourceBlock:String(block.number)};
   if(P.rail==='x402-wallet')return {...shared,walletAddress:P.payer,chainId:8453,walletUsdcMicro:String(resource)};
   return {...shared,providerBinding:binding,providerAutoTopup:resource.providerAutoTopup,prepaid:resource.prepaid};
  },
  async quote(claimWei){
   const client=clients[1];await verifyPins();
   const {result}=await client.simulateContract({address:P.quoter,abi,functionName:'quoteExactInputSingle',args:[P.weth,P.usdc1,P.fee,BigInt(claimWei),0n]});
   return {amountOut:String(result),observedAt:now()};
  },
  async attestation(message,originalMessageHash,burnTransaction){
   if(keccak256(message)!==originalMessageHash)throw Error('funding_attestation_message_changed');
   // Circle signs the exact MessageSent bytes. Its signature is verified by
   // the pinned destination MessageTransmitter during simulation/execution.
   if(!/^0x[0-9a-f]{64}$/i.test(burnTransaction??''))throw Error('funding_original_burn_hash_required');
   const r=await request('https://iris-api.circle.com/v2/messages/0?transactionHash='+burnTransaction,{redirect:'error',signal:AbortSignal.timeout(15000)});
   if(r.status===404)return null;if(!r.ok)throw Error('funding_attestation_unavailable');
   const text=await r.text();if(text.length>20000)throw Error('funding_attestation_size');
   const values=JSON.parse(text).messages;if(!Array.isArray(values)||values.length!==1)throw Error('funding_original_message_count');
   const value=values[0];if(value.status!=='complete')return null;
   if(!/^0x[0-9a-f]+$/i.test(value.attestation??''))throw Error('funding_attestation_invalid');
   const checked=validateAttestedMessage(message,value.message);
   if(BigInt(checked.expirationBlock)!==0n&&BigInt(checked.expirationBlock)<await clients[8453].getBlockNumber()+100n)throw Error('funding_original_attestation_expiring');
   return {message:value.message,attestation:value.attestation};
  }
 };
}
