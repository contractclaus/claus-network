import {encodeFunctionData,parseAbi,keccak256,zeroAddress} from 'viem';
export const CORE=Object.freeze({
 token:'0x1b54e762aa34cf6e28e9c082f2848e28e45da6b8',hook:'0x37bfb8ac7c960e558657871d41ca70e07e7dbfff',
 owner:'0xbb145ca83272c3806d4ddc75ca1d5514789cf1c5',host:'0xea0436465676ea7001535bfe2e5cbd4b137b7f91',
 tokenImplementation:'0x55d555bd85fed6ecf30fda9b4c76019b844218a7',tokenHash:'0x18711facb8370d37c7c26663c603a830ba83f843b3396f6a62eb1eb4f7244dd2',
 hookImplementation:'0xa62f9b597225779b430024398b70374e8468ce14',hookHash:'0x0135248dad9b583303bf5803c27523bc88fa012dd8823309c216423ca786dd89',
 hostHash:'0x342ce58548aab158ef05a03860e785206940606d38ac46131900bab0cc7ee868',
 implementationSlot:'0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
});
export const PROGRAM_ABI=parseAbi(['function activeModule() view returns(address)','function setModule(address module)','function owner() view returns(address)','function pendingOwner() view returns(address)','function program() view returns(address)','function programCodeHash() view returns(bytes32)','function TREASURY_PIPS() view returns(uint256)']);
export const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
export async function readCore(client){
 if(await client.getChainId()!==1)throw Error('program_chain_mismatch');
 const block=await client.getBlock({blockTag:'latest'}),blockNumber=block.number;
 const code=address=>client.getCode({address,blockNumber});
 const [tokenWord,hookWord,tokenCode,hookCode,hostCode,owner,pendingOwner,activeModule]=await Promise.all([
  client.getStorageAt({address:CORE.token,slot:CORE.implementationSlot,blockNumber}),client.getStorageAt({address:CORE.hook,slot:CORE.implementationSlot,blockNumber}),
  code(CORE.tokenImplementation),code(CORE.hookImplementation),code(CORE.host),
  client.readContract({address:CORE.token,abi:PROGRAM_ABI,functionName:'owner',blockNumber}),
  client.readContract({address:CORE.token,abi:PROGRAM_ABI,functionName:'pendingOwner',blockNumber}),
  client.readContract({address:CORE.host,abi:PROGRAM_ABI,functionName:'activeModule',blockNumber})
 ]);
 if(!same('0x'+tokenWord?.slice(-40),CORE.tokenImplementation)||!same('0x'+hookWord?.slice(-40),CORE.hookImplementation)||
  !tokenCode||keccak256(tokenCode)!==CORE.tokenHash||!hookCode||keccak256(hookCode)!==CORE.hookHash||!hostCode||keccak256(hostCode)!==CORE.hostHash||
  !same(owner,CORE.owner)||!same(pendingOwner,zeroAddress))throw Error('program_core_changed');
 return {blockNumber:blockNumber.toString(),blockHash:block.hash,activeModule};
}
export function selectTransaction(module){return {chainId:1,to:CORE.host,value:'0',data:encodeFunctionData({abi:PROGRAM_ABI,functionName:'setModule',args:[module]}),checks:[{to:CORE.host,data:encodeFunctionData({abi:PROGRAM_ABI,functionName:'activeModule'}),expected:'0x'+'0'.repeat(24)+module.slice(2).toLowerCase()}]};}
export function assertProgramSignature(tx,expected,limits,spent,balance){
 const maxGas=BigInt(limits.maximumGas),maxFee=BigInt(limits.maximumFeePerGasWei),total=BigInt(limits.totalGasWei),perTx=BigInt(limits.transactionGasWei),reserve=BigInt(limits.reserveWei);
 if(tx.chainId!==1||tx.type!=='eip1559'||(tx.value??0n)!==0n||!same(tx.data,expected.data)||
  ((tx.to??null)!==null?!same(tx.to,expected.to):expected.to!==undefined)||
  typeof tx.gas!=='bigint'||tx.gas<21000n||tx.gas>maxGas||typeof tx.maxFeePerGas!=='bigint'||tx.maxFeePerGas<=0n||tx.maxFeePerGas>maxFee||
  typeof tx.maxPriorityFeePerGas!=='bigint'||tx.maxPriorityFeePerGas<0n||tx.maxPriorityFeePerGas>tx.maxFeePerGas||
  tx.gas*tx.maxFeePerGas>perTx||spent+tx.gas*tx.maxFeePerGas>total||balance-tx.gas*tx.maxFeePerGas<reserve)
  throw Error('program_transaction_refused');
}
