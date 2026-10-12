import {digest, requireThat} from '../src/shared/index.mjs';

// One finalized RPC range per tick. A missing event is conclusive only after
// the complete eligible history has been scanned; cursors never imply success.
export async function recoverChainEvent({store, client, chainId, key, query, fromBlock, validateEmpty}) {
  const id=digest({chainId,key,query}), old=await store.read('chain-event-recovery',id);
  const head=await client.getBlock({blockTag:'finalized'});
  if(old) requireThat((await client.getBlock({blockNumber:BigInt(old.value.blockNumber)})).hash===old.value.blockHash,'recovery_block_changed');
  const start=BigInt(old?.value.nextBlock??fromBlock);
  if(start>head.number)return {complete:true,logs:[],finalizedBlock:head};
  const end=start+9999n<head.number?start+9999n:head.number;
  const logs=await client.getLogs({...query,fromBlock:start,toBlock:end});
  requireThat(logs.length<=10,'recovery_event_mismatch');
  if(logs.length)return {complete:true,logs,finalizedBlock:head};
  await validateEmpty?.({ fromBlock: start, toBlock: end });
  const block=end===head.number?head:await client.getBlock({blockNumber:end});
  await store.transaction(async tx=>{
    const current=await tx.read('chain-event-recovery',id);
    requireThat((current?.revision??0)===(old?.revision??0),'revision_conflict');
    await tx.write('chain-event-recovery',id,{nextBlock:String(end+1n),blockNumber:String(end),blockHash:block.hash},current?.revision??0);
  });
  return {complete:end===head.number,logs:[],finalizedBlock:head};
}
