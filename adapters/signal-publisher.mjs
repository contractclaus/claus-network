import {encodeFunctionData,keccak256} from 'viem';
import {amount,digest,integer,requireThat,shape,text} from '../src/shared/index.mjs';
import {createReadonlyTransactions} from './sepolia-transactions.mjs';
import {signalAbi} from './signal-read.mjs';

// Host-only finite allocation for the Claus reference. Public users bring their
// own signer/gas. Changing a configuration never refills an old allocation.
export async function admitSignalPublisherBudget(store,config){
 shape(config,['id','chainId','projectId','store','storeCodeHash','publisher','grantId','expiresAt',
  'maximumTransactions','maximumTotalWei','maximumTransactionWei','maximumGas','maximumFeePerGas']);
 text(config.id);text(config.projectId);integer(config.expiresAt,1);integer(config.maximumTransactions,1,10000);
 requireThat([1,11155111].includes(config.chainId)&&[config.store,config.publisher].every(x=>/^0x[0-9a-f]{40}$/.test(x)&&!/^0x0{40}$/.test(x))&&
  [config.storeCodeHash,config.grantId].every(x=>/^0x[0-9a-f]{64}$/.test(x)),'invalid_signal_budget');
 requireThat(amount(config.maximumTransactionWei)>0n&&amount(config.maximumTransactionWei)<=1000000000000000n&&
  amount(config.maximumTotalWei)>=amount(config.maximumTransactionWei)&&amount(config.maximumTotalWei)<=20000000000000000n&&
  amount(config.maximumGas)>0n&&amount(config.maximumGas)<=1000000n&&amount(config.maximumFeePerGas)>0n&&
  amount(config.maximumFeePerGas)<=50000000000n,'invalid_signal_budget');
 return store.transaction(async tx=>{
  const row=await tx.read('signal-publisher-budgets',config.id);
  if(row){requireThat(row.value.configHash===digest(config),'idempotency_conflict');return row.value;}
  const value={config,configHash:digest(config),transactions:0,reserved:'0',spent:'0',revokedAt:null};
  await tx.write('signal-publisher-budgets',config.id,value,0);return value;
 });
}
export function createSignalPublisher({store,client,signer,sealer,identity,services,signals,budget,now=Date.now}){
 requireThat(signer.address.toLowerCase()===budget.publisher,'worker_signer_mismatch');
 const configHash=digest(budget);
 async function ledger(reader){const row=await reader.read('signal-publisher-budgets',budget.id);
  requireThat(row?.value.configHash===configHash&&digest(row.value.config)===configHash,'signal_budget_changed');return row;}
 const reserve=async(tx,{id,maximum})=>{
  const row=await ledger(tx),v=row.value;
  requireThat(!v.revokedAt&&budget.expiresAt>now(),'transaction_not_authorized');
  requireThat(v.transactions<budget.maximumTransactions&&amount(v.spent)+amount(v.reserved)+amount(maximum)<=amount(budget.maximumTotalWei),'signal_budget_exhausted');
  requireThat(!await tx.read('signal-publisher-reservations',id),'signal_reservation_exists');
  await tx.write('signal-publisher-budgets',budget.id,{...v,transactions:v.transactions+1,reserved:(amount(v.reserved)+amount(maximum)).toString()},row.revision);
  await tx.write('signal-publisher-reservations',id,{budgetId:budget.id,maximum,state:'reserved',actual:null},0);
 };
 const finalize=async(tx,{id,state,actual})=>{
  const row=await ledger(tx),item=await tx.read('signal-publisher-reservations',id);
  requireThat(item?.value.budgetId===budget.id&&item.value.state==='reserved'&&amount(actual)<=amount(item.value.maximum)&&
   amount(row.value.reserved)>=amount(item.value.maximum),'signal_settlement_mismatch');
  await tx.write('signal-publisher-budgets',budget.id,{...row.value,reserved:(amount(row.value.reserved)-amount(item.value.maximum)).toString(),
   spent:(amount(row.value.spent)+amount(actual)).toString()},row.revision);
  await tx.write('signal-publisher-reservations',id,{...item.value,state,actual},item.revision);
 };
 return {async step(operation){
  const original=(await store.read('signal-operations',operation.id))?.value;
  requireThat(original?.kind==='record'&&original.projectId===budget.projectId&&digest(original.transaction)===digest(operation.transaction), 'signal_operation_mismatch');
  const input=original.input,sourceHash='0x'+digest(input.sourceResult).slice(7);
  const data=encodeFunctionData({abi:signalAbi,functionName:'publish',args:[input.grantId,input.sequence,input.expectedVersion,
   input.observedAt,input.validUntil,sourceHash,input.data]});
  requireThat(input.grantId===budget.grantId&&original.transaction.chainId===budget.chainId&&original.transaction.from===budget.publisher&&
   original.transaction.to===budget.store&&original.transaction.value==='0'&&original.transaction.data===data,'signal_operation_mismatch');
  const id='signal-record:'+operation.id,authority={kind:'signal-record',operationId:operation.id,projectId:budget.projectId,
   budgetId:budget.id,configHash,grantId:budget.grantId};
  const expiresAt=Math.min(input.validUntil*1000,budget.expiresAt);
  const prior=(await store.read('chain-transactions',id))?.value;
  let codeMatches=false;
  if(!prior||prior.state==='prepared')codeMatches=keccak256(await client.getCode({address:budget.store}))===budget.storeCodeHash;
  else if(['unknown','submitted','broadcasting'].includes(prior.state)){
   try{codeMatches=keccak256(await client.getCode({address:budget.store}))===budget.storeCodeHash;}catch{/* Reconcile receipts; do not rebroadcast without fresh code identity. */}
  }
  const transactions=createReadonlyTransactions({store,client,signer,sealer,chainId:budget.chainId,finalized:true,now,
   limits:{gas:budget.maximumGas,feePerGas:budget.maximumFeePerGas,cost:budget.maximumTransactionWei},onReserve:reserve,onFinalize:finalize,
   authorize:async(candidate,reader)=>{
    requireThat(candidate.to===budget.store&&candidate.data===data&&candidate.value==='0'&&candidate.expiresAt===expiresAt&&
     digest(candidate.authority)===digest(authority),'signal_operation_mismatch');
    const row=await ledger(reader);if(row.value.revokedAt||budget.expiresAt<=now()||!codeMatches)return false;
    await identity.authorize(original.actor,'signal.publish',{projectId:budget.projectId},reader);
    await signals.admission(budget.chainId,reader);
    if(await reader.read('signal-revocations',digest({projectId:budget.projectId,grantId:input.grantId})))return false;
    const source=await services.publicResult(input.sourceResult.id,reader);
    return source.revision===input.sourceResult.revision&&source.outputHash===input.sourceResult.outputHash&&source.output.onchainData===input.data;
   }});
  let current=await transactions.status(id);
  if(current)requireThat(current.intent.data===data&&current.intent.to===budget.store&&current.intent.expiresAt===expiresAt&&
   digest(current.intent.authority)===digest(authority),'signal_operation_mismatch');
  if(!current)current=await transactions.prepare({id,to:budget.store,data,authority,expiresAt});
  if(current.state==='prepared')current=await transactions.submit(id);
  if(['broadcasting','submitted','unknown'].includes(current.state))current=await transactions.reconcile(id);
  return {state:current.state==='confirmed'?'confirmed':['cancelled','reverted'].includes(current.state)?'failed':'pending',
   ...(current.state!=='cancelled'?{transactionHash:current.hash}:{}),
   ...(['cancelled','reverted'].includes(current.state)?{error:'signal_transaction_'+current.state}:{}),transactionId:id};
 }};
}
