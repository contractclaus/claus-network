import { decodeEventLog, encodeAbiParameters, encodeFunctionData, keccak256, zeroAddress } from 'viem';
import { digest, requireThat } from '../src/shared/index.mjs';
import { createSepoliaTransactions } from './sepolia-transactions.mjs';
import { walletAbi } from './wallet-abi.mjs';
import { authorityDenied } from './authorization.mjs';

export function createWalletExecutor({ store, client, signer, sealer, artifacts, verification, chain, now = () => Date.now() }) {
  return { async step({ value, signature, authorize }) {
    const request = value.request, deploy = value.kind === 'wallet-deploy';
    let artifact, constructorArguments;
    if (deploy) {
      artifact = await artifacts.get(request.artifactProjectId, request.artifactHash);
      requireThat(artifact.contract === 'ClausProjectWallet' && /^0x[0-9a-f]+$/i.test(artifact.creationBytecode), 'unsupported_wallet_profile');
      constructorArguments = encodeAbiParameters([{type:'address'}],[request.owner]);
    }
    const to = deploy ? null : request.wallet;
    const data = deploy ? artifact.creationBytecode+constructorArguments.slice(2) : encodeFunctionData({ abi:walletAbi,
      functionName:value.kind==='wallet-session'?'authorizeSession':'pay',args:[request.typedData.message,signature] });
    let fresh = true;
    const transactions = createSepoliaTransactions({ store, client, signer, sealer, now,
      authorize: async (intent, reader) => {
        requireThat(intent.to===to && intent.data===data && digest(intent.authority)===digest({kind:value.kind,actionId:value.id}), 'executor_intent_mismatch');
        return fresh && authorize(reader);
      } });
    const id='wallet:'+value.id;let tx=await transactions.status(id);
    if (!tx || tx.state==='prepared') {
      try {
        requireThat(request.expiresAt>now(),'payment_expired');
        if (!deploy) {
          const wallet=(await store.read('project-wallets',value.projectId)).value;
          requireThat(wallet.address.toLowerCase()===request.wallet.toLowerCase(), 'wallet_profile_changed');
          await chain.validateAction(wallet,request.typedData,signature);
        }
        requireThat(await authorize(store)===true,'transaction_not_authorized');
      } catch(error) { if(!authorityDenied(error))throw error;fresh=false;if(!tx)return{state:'blocked',error:error.code}; }
    }
    if (!tx) tx=await transactions.prepare({id,to,data,authority:{kind:value.kind,actionId:value.id},expiresAt:request.expiresAt});
    tx=await transactions.submit(id);
    if (!['confirmed','reverted','cancelled'].includes(tx.state))tx=await transactions.reconcile(id);
    if(tx.state==='cancelled')return{state:'blocked',error:'authority_or_window_closed'};
    if(tx.state==='reverted')return{state:'failed',error:'transaction_reverted',transactionHash:tx.hash,receipt:tx.receipt};
    if(tx.state!=='confirmed')return{state:'submitted',transactionHash:tx.hash};
    if(deploy){
      const address=tx.receipt.contractAddress;
      const owner=await client.readContract({address,abi:walletAbi,functionName:'owner'});
      requireThat(owner.toLowerCase()===request.owner.toLowerCase(),'wallet_owner_mismatch');
      const codeHash=keccak256(await client.getCode({address}));
      const proof=await verification.step({address,artifact,constructorArguments,creationTransaction:tx.hash});
      return{state:proof.state==='verified'?'verified':'verifying',address,codeHash,verification:proof,transactionHash:tx.hash,receipt:tx.receipt};
    }
    const receipt=await client.getTransactionReceipt({hash:tx.hash});
    const eventName=value.kind==='wallet-session'?'SessionAuthorized':'PaymentMade';
    const events=receipt.logs.filter(log=>log.address.toLowerCase()===to.toLowerCase()).flatMap(log=>{
      try{return[decodeEventLog({abi:walletAbi,eventName,data:log.data,topics:log.topics})];}catch{return[];}
    }).filter(log=>log.eventName===eventName);
    requireThat(events.length===1,'wallet_receipt_mismatch');
    const e=events[0].args,m=request.typedData.message;
    requireThat(e.sessionId===m.sessionId && e.generation===BigInt(m.generation),'wallet_receipt_mismatch');
    if(value.kind==='wallet-session'){
      requireThat(e.signer.toLowerCase()===m.signer.toLowerCase() && e.recipient.toLowerCase()===m.recipient.toLowerCase() &&
        e.asset.toLowerCase()===m.asset.toLowerCase() && e.perPayment===BigInt(m.perPayment) && e.total===BigInt(m.total) &&
        e.validAfter===BigInt(m.validAfter) && e.validUntil===BigInt(m.validUntil),'wallet_receipt_mismatch');
      return{state:'confirmed',transactionHash:tx.hash,receipt:tx.receipt};
    }
    requireThat(e.quoteHash===m.quoteHash && e.recipient.toLowerCase()===m.recipient.toLowerCase() &&
      e.asset===zeroAddress && e.amount===BigInt(m.amount) && e.nonce===BigInt(m.nonce),'wallet_receipt_mismatch');
    return{state:'confirmed',transactionHash:tx.hash,receipt:tx.receipt,paymentEvidence:{
      quoteHash:'sha256:'+e.quoteHash.slice(2),chainId:11155111,transactionHash:tx.hash,
      amountWei:e.amount.toString(),recipient:e.recipient}};
  } };
}
