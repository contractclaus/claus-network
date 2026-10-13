import {requireThat} from '../src/shared/index.mjs';

// Read-only recovery. A higher nonce alone is not evidence that our transaction
// did not execute. Find the exact competing transaction in finalized history.
export async function finalizedReplacement(client,{sender,nonce,hash}){
 const final=await client.getBlock({blockTag:'finalized'});
 if(await client.getTransactionCount({address:sender,blockNumber:final.number})<=nonce)return null;
 let low=0n,high=final.number;
 for(let steps=0;low<high&&steps<64;steps++){
  const middle=(low+high)/2n;
  if(await client.getTransactionCount({address:sender,blockNumber:middle})>nonce)high=middle;
  else low=middle+1n;
 }
 requireThat(low===high,'replacement_history_incomplete');
 const block=await client.getBlock({blockNumber:low,includeTransactions:true});
 const replacement=block.transactions.find(tx=>typeof tx==='object'&&tx.from.toLowerCase()===sender.toLowerCase()&&tx.nonce===nonce);
 if(!replacement||replacement.hash===hash)return null;
 const receipt=await client.getTransactionReceipt({hash:replacement.hash});
 requireThat(receipt.transactionHash===replacement.hash&&receipt.blockNumber===block.number&&receipt.blockHash===block.hash&&
  receipt.from.toLowerCase()===sender.toLowerCase()&&(await client.getBlock({blockNumber:final.number})).hash===final.hash&&
  (await client.getBlock({blockNumber:block.number})).hash===block.hash,'replacement_evidence_changed');
 return {transactionHash:replacement.hash,blockNumber:String(block.number),blockHash:block.hash,
  finalizedBlockNumber:String(final.number),finalizedBlockHash:final.hash};
}
