import {createRequire} from 'node:module';
import {FUNDING as P,validateFundingApproval,fundingHash} from './policy.mjs';
import {fundingTransaction} from './transactions.mjs';
const {keccak256,serializeTransaction,parseAbi,parseTransaction,recoverTransactionAddress}=createRequire(import.meta.url)('viem');
const json=v=>JSON.parse(JSON.stringify(v,(_,x)=>typeof x==='bigint'?String(x):x));
const check=(v,s)=>{if(!v)throw Error(s);};
const baseFees=parseAbi(['function getL1FeeUpperBound(uint256) view returns(uint256)','function operatorFeeScalar() view returns(uint32)','function operatorFeeConstant() view returns(uint64)']);
// Uses the same Dev Wallet chain lock/nonce journal as existing wallet work.
// The payer uses its own copy of that journal in its existing database.
// No endpoint exposes this constructor or its trusted account/repository ports.
export function originalFundingExecutor({clients,accounts,repositories,fundingStore,approval,binding,gasExposure,now=Date.now}){
 return async(id,input,{cycleId,step,l1GasCap,baseGasCap,readOnly=false})=>{
  if(!readOnly)validateFundingApproval(approval,{binding,now:now()});
  const original=await fundingStore.step(cycleId,step);
  check(original?.id===id&&fundingHash(original.transaction)===fundingHash(input),'funding_original_binding');
  check(fundingHash(fundingTransaction(step,original.context))===fundingHash(input),'funding_transaction_not_fixed');
  const chain=input.chainId,client=clients[chain],account=accounts[chain],repo=repositories[chain];
  check((readOnly||account.address.toLowerCase()===input.from)&&await client.getChainId()===chain,'funding_chain_or_account_changed');
  const tx={chainId:chain,to:input.to,data:input.data,value:input.value,checks:[]};
  let row=await repo.get(id);
  if(!row&&readOnly)return null;
  if(!row){const r=await repo.reserve(id,'transaction',{chainId:chain,transaction:tx});row=r.row;if(r.created){await repo.save(id,'prepared',{fundingCycle:cycleId});row=await repo.get(id);}}
  check(fundingHash(row.input)===fundingHash({chainId:chain,transaction:tx}),'funding_wallet_journal_conflict');
  const receipt=async()=>{
   if(!row.signed)return null;
   const r=await client.getTransactionReceipt({hash:row.signed.hash}).catch(e=>{if(e?.name==='TransactionReceiptNotFoundError')return null;throw e;});if(!r)return null;
   const final=await client.getBlock({blockTag:'finalized'});if(r.blockNumber>final.number)return null;
   const block=await client.getBlock({blockNumber:r.blockNumber});check(block.hash===r.blockHash,'funding_receipt_reorg');
   check(r.transactionHash===row.signed.hash&&r.from.toLowerCase()===input.from&&r.to.toLowerCase()===input.to,'funding_receipt_identity');
   await repo.save(id,r.status==='success'?'included':'reverted',{...row.result,receipt:json(r),transactionHash:r.transactionHash});
   await repo.unlock(id,chain);
   return {...json(r),finalized:true};
  };
  async function broadcastOnce(){
   // A persisted signature without a broadcast intent is safe to submit once.
   // A lost response/intent stays held: never resend or sign a replacement.
   if(await repo.claimBroadcast(id,now()))try{check(await client.sendRawTransaction({serializedTransaction:row.signed.raw})===row.signed.hash,'funding_broadcast_hash_mismatch');}catch{}
   row=await repo.get(id);return receipt();
  }
  if(readOnly)return receipt();
  if(row.signed)return broadcastOnce();
  check(row.status==='prepared','funding_signature_or_original_outcome_unknown');
  if(!await repo.claim(id,chain))return null;
  let signed=false,signingStarted=false;
  try{
   const [latest,pending,fees,estimate,balance,lastNonce]=await Promise.all([
    client.getTransactionCount({address:account.address,blockTag:'latest'}),client.getTransactionCount({address:account.address,blockTag:'pending'}),
    client.estimateFeesPerGas(),client.estimateGas({...tx,value:BigInt(tx.value),account:account.address}),client.getBalance({address:account.address}),repo.lastNonce(chain)]);
   check(latest===pending&&(lastNonce===null||pending>Number(lastNonce)),'funding_nonce_requires_reconciliation');
   const wire={chainId:chain,to:tx.to,data:tx.data,value:BigInt(tx.value),nonce:pending,gas:(estimate*120n+99n)/100n,maxFeePerGas:fees.maxFeePerGas,maxPriorityFeePerGas:fees.maxPriorityFeePerGas,type:'eip1559'};
   let maximum=wire.gas*wire.maxFeePerGas;
   if(chain===8453){
    const size=BigInt((serializeTransaction(wire).length-2)/2+100);
    const [l1,scalar,constant]=await Promise.all([client.readContract({address:'0x420000000000000000000000000000000000000f',abi:baseFees,functionName:'getL1FeeUpperBound',args:[size]}),client.readContract({address:'0x4200000000000000000000000000000000000015',abi:baseFees,functionName:'operatorFeeScalar'}),client.readContract({address:'0x4200000000000000000000000000000000000015',abi:baseFees,functionName:'operatorFeeConstant'})]);
    maximum+=(l1+wire.gas*BigInt(scalar)*100n+constant)*4n;
   }
   const exposure=BigInt(await gasExposure(cycleId,chain));
   check(exposure+maximum<=BigInt(chain===1?l1GasCap:baseGasCap)&&balance>=wire.value+maximum+(chain===1?BigInt(P.minimumOwnerBalanceWei):0n),'funding_gas_or_balance_cap');
   await client.call({...wire,account:account.address});
   // Preserve a signing intent before invoking the signer. Any interrupted
   // signature attempt keeps the original chain lock; never assume absent.
   await repo.save(id,'signing',{fundingCycle:cycleId,maximumFeeWei:String(maximum),wire:json(wire)});
   signingStarted=true;
   const raw=await account.signTransaction(wire);signed=true;
   const decoded=parseTransaction(raw);
   check((await recoverTransactionAddress({serializedTransaction:raw})).toLowerCase()===input.from,'funding_signature_sender');
   for(const k of ['chainId','to','data','value','nonce','gas','maxFeePerGas','maxPriorityFeePerGas'])check(String(decoded[k]).toLowerCase()===String(wire[k]).toLowerCase(),'funding_signature_binding:'+k);
   const hash=keccak256(raw);await repo.save(id,'signed',{fundingCycle:cycleId,maximumFeeWei:String(maximum),transactionHash:hash},json({raw,hash,nonce:wire.nonce}));
   row=await repo.get(id);
   return broadcastOnce();
  }catch(e){
   if(!signingStarted&&!signed){await repo.save(id,'prepared',{fundingCycle:cycleId,unsignedPreflightDeferred:true});await repo.unlock(id,chain);}
   throw e;
  }
 };
}
