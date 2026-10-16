import {keccak256,parseAbi,encodeAbiParameters,encodeFunctionData,parseSignature} from 'viem';
import fs from 'node:fs';
import {PAYER,USDC,check,same,termsHash} from './policy.mjs';
export const template=JSON.parse(fs.readFileSync(new URL('./escrow.json',import.meta.url),'utf8'));
export const tokenAbi=parseAbi(['function balanceOf(address) view returns (uint256)','function authorizationState(address,bytes32) view returns (bool)']);
export async function observeInvestment(client,value,{finalized=false}={}){
 check(await client.getChainId()===8453,'chain');
 const block=await client.getBlock({blockTag:finalized?'finalized':'latest'}),e=value.execution,t=value.terms,address=e.escrow;
 const code=await client.getCode({address,blockNumber:block.number});
 check(same(code,template.runtimeTemplate),'escrow_runtime');
 const names=['INVESTOR','USDC','counterparty','amount','expiresAt','termsHash','mode','deliveryToken','deliveryAmount','deliveryCodeHash','state','authorizationNonce'];
 const values=await Promise.all(names.map(functionName=>client.readContract({address,abi:template.abi,functionName,blockNumber:block.number})));
 const state=Object.fromEntries(names.map((n,i)=>[n,values[i]]));
 check(same(state.INVESTOR,PAYER)&&same(state.USDC,USDC)&&same(state.counterparty,t.counterparty)&&String(state.amount)===e.amount&&String(state.expiresAt)===String(t.expiresAt)&&same(state.termsHash,termsHash(value))&&Number(state.mode)===e.mode&&same(state.deliveryToken,e.deliveryToken)&&String(state.deliveryAmount)===e.deliveryAmount&&same(state.deliveryCodeHash,e.deliveryCodeHash),'escrow_terms');
 const nonce=keccak256(encodeAbiParameters([{type:'uint256'},{type:'address'},{type:'bytes32'}],[8453n,address,termsHash(value)]));
 check(same(state.authorizationNonce,nonce),'escrow_nonce');
 const used=await client.readContract({address:USDC,abi:tokenAbi,functionName:'authorizationState',args:[PAYER,nonce],blockNumber:block.number});
 if(e.mode===1)check(keccak256(await client.getCode({address:e.deliveryToken,blockNumber:block.number})??'0x')===e.deliveryCodeHash,'delivery_code');
 return {state:Number(state.state),nonce,used,blockNumber:String(block.number),blockHash:block.hash,timestamp:Number(block.timestamp),finalized};
}
export function investmentSignature(value,observed){
 const e=value.execution,t=value.terms;
 check(observed.timestamp<t.expiresAt,'agreement_expired');
 if(value.action==='fund'){
  check(observed.state===0&&!observed.used,'already_funded');
  return {domain:{name:'USD Coin',version:'2',chainId:8453,verifyingContract:USDC},primaryType:'ReceiveWithAuthorization',types:{ReceiveWithAuthorization:[{name:'from',type:'address'},{name:'to',type:'address'},{name:'value',type:'uint256'},{name:'validAfter',type:'uint256'},{name:'validBefore',type:'uint256'},{name:'nonce',type:'bytes32'}]},message:{from:PAYER,to:e.escrow,value:BigInt(e.amount),validAfter:0n,validBefore:BigInt(t.expiresAt),nonce:observed.nonce}};
 }
 check(value.action==='release'&&observed.state===1&&observed.used,'release_state');
 return {domain:{name:'Claus Capital Escrow',version:'1',chainId:8453,verifyingContract:e.escrow},primaryType:'Release',types:{Release:[{name:'termsHash',type:'bytes32'},{name:'deliveryHash',type:'bytes32'}]},message:{termsHash:termsHash(value),deliveryHash:value.delivery.hash}};
}
export function relayPayload(value,signature){
 const {r,s,v,yParity}=parseSignature(signature),vv=Number(v??BigInt(27+yParity));
 return {chainId:8453,to:value.execution.escrow,value:'0',data:encodeFunctionData({abi:template.abi,functionName:value.action==='fund'?'fund':'release',args:value.action==='fund'?[vv,r,s]:[value.delivery.hash,vv,r,s]})};
}
