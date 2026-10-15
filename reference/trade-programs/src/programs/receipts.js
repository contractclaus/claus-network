import {parseAbi,decodeEventLog,encodeFunctionData,encodeAbiParameters,keccak256,zeroHash} from 'viem';
import {CORE,same} from './policy.js';
const tuple='(uint256 id,address module,address sender,bool buy,int128 amount0,int128 amount1,uint256 feeEth,uint256 moduleFeeEth,uint256 blockNumber,uint256 timestamp,bytes32 dataHash)';
export const RECEIPT_ABI=parseAbi([
 'event TradeRecorded(uint256 indexed id,address indexed module,'+tuple+' trade)',
 'function pending(uint256) view returns(bytes32)',
 'function execute('+tuple+' trade,bytes hookData,uint256 gasLimit)'
]);
const components=RECEIPT_ABI.find(x=>x.name==='execute').inputs[0].components;
export function receiptInput(input){
 if(!input||Object.keys(input).some(k=>!['transactionHash','logIndex','hookData','gasLimit'].includes(k))||
  !/^0x[a-f0-9]{64}$/i.test(input.transactionHash??'')||!Number.isSafeInteger(input.logIndex)||input.logIndex<0||input.logIndex>100000||
  !/^0x(?:[a-f0-9]{2})*$/i.test(input.hookData??'')||input.hookData.length>8194||!Number.isSafeInteger(input.gasLimit)||input.gasLimit<10000||input.gasLimit>1000000)throw Error('program_invalid_receipt');
 return input;
}
export async function delivery(client,adapter,input){
 receiptInput(input);
 const receipt=await client.getTransactionReceipt({hash:input.transactionHash});
 const block=await client.getBlock({blockNumber:receipt.blockNumber});
 if(receipt.status!=='success'||block.hash!==receipt.blockHash||!same(receipt.transactionHash,input.transactionHash))throw Error('program_receipt_not_canonical');
 const log=receipt.logs.find(l=>l.logIndex===input.logIndex&&same(l.address,CORE.host));if(!log)throw Error('program_receipt_missing');
 const event=decodeEventLog({abi:RECEIPT_ABI,data:log.data,topics:log.topics,strict:true});
 const trade=event.args.trade;
 if(event.eventName!=='TradeRecorded'||!same(event.args.module,adapter)||!same(trade.module,adapter)||event.args.id!==trade.id||trade.blockNumber!==receipt.blockNumber||
  trade.timestamp!==block.timestamp||trade.dataHash!==keccak256(input.hookData))throw Error('program_receipt_mismatch');
 const pending=await client.readContract({address:CORE.host,abi:RECEIPT_ABI,functionName:'pending',args:[trade.id]});
 if(pending===zeroHash)return {consumed:true,receiptId:trade.id.toString()};
 if(pending!==keccak256(encodeAbiParameters([{type:'tuple',components}],[trade])))throw Error('program_receipt_commitment_mismatch');
 return {consumed:false,receiptId:trade.id.toString(),transaction:{chainId:1,to:CORE.host,value:'0',data:encodeFunctionData({abi:RECEIPT_ABI,functionName:'execute',args:[trade,input.hookData,BigInt(input.gasLimit)]}),
  checks:[{to:CORE.host,data:encodeFunctionData({abi:RECEIPT_ABI,functionName:'pending',args:[trade.id]}),expected:zeroHash}]}};
}
export async function pendingReceipts(client,adapter,fromBlock){
 if(!/^[0-9]{1,20}$/.test(fromBlock??''))throw Error('program_invalid_block');
 const head=await client.getBlockNumber(),from=BigInt(fromBlock);if(from>head) return {items:[],nextBlock:from.toString(),head:head.toString()};
 const to=from+999n<head?from+999n:head;
 const logs=await client.getLogs({address:CORE.host,event:RECEIPT_ABI[0],args:{module:adapter},fromBlock:from,toBlock:to,strict:true});
 if(logs.length>500)throw Error('program_receipt_range_too_dense');
 const items=[];
 for(let i=0;i<logs.length;i+=8){
  const batch=await Promise.all(logs.slice(i,i+8).map(async log=>({log,pending:await client.readContract({address:CORE.host,abi:RECEIPT_ABI,functionName:'pending',args:[log.args.id]})})));
  for(const {log,pending}of batch)if(pending!==zeroHash)items.push({receiptId:log.args.id.toString(),transactionHash:log.transactionHash,logIndex:log.logIndex,blockNumber:log.blockNumber.toString(),dataHash:log.args.trade.dataHash,moduleFeeEth:log.args.trade.moduleFeeEth.toString()});
 }
 return {items,nextBlock:(to+1n).toString(),head:head.toString(),meaning:'Observed pending original receipts; revalidate at delivery. Nonempty hookData must be recovered from its original transaction, not invented.'};
}
