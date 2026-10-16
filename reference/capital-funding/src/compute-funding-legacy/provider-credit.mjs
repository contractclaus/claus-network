import {FUNDING as P} from './policy.mjs';
import {validateProviderCredit} from './prepaid.mjs';

export const historySource='https://api.surplusintelligence.ai/v1/payments/history';
// This is a read-only adapter. It does not log in, create keys, spend, or accept
// evidence supplied through an API request. Missing transaction references are
// unsupported evidence, not an invitation to match by amount or by timestamp.
export async function readProviderHistory({request=fetch,key,cursor=null,now=Date.now}){
 if(cursor!==null&&(typeof cursor!=='string'||!cursor||cursor.length>4096))throw Error('funding_provider_cursor_invalid');
 const observedAt=now();
 const unavailable=(reason,status=null,requestId=null,retryMs=300000)=>({state:'unavailable',reason,status,requestId,observedAt,nextReadAt:observedAt+retryMs,cursor});
 try{
  const url=historySource+(cursor?'?cursor='+encodeURIComponent(cursor):'');
  const response=await request(url,{headers:{authorization:'Bearer '+key},redirect:'error',signal:AbortSignal.timeout(10000)});
  const requestId=response.headers.get('x-request-id')?.slice(0,160)??null;
  if(!response.ok){
   const retry=Number(response.headers.get('retry-after'));
   return unavailable('provider_history_http_'+response.status,response.status,requestId,Math.max(response.status===404?3600000:300000,Number.isFinite(retry)?Math.min(86400,retry)*1000:0));
  }
  const text=await response.text();if(text.length>200000)return unavailable('provider_history_too_large',200,requestId);
  const body=JSON.parse(text),nextCursor=body.next_cursor??null;
  if(!Array.isArray(body.items)||body.items.length>50||body.items.some(x=>!x||typeof x!=='object'||Array.isArray(x))||(nextCursor!==null&&(typeof nextCursor!=='string'||!nextCursor||nextCursor.length>4096||nextCursor===cursor)))return unavailable('provider_history_shape',200,requestId);
  return {state:'available',items:body.items,nextCursor,requestId,source:historySource,observedAt};
 }catch{return unavailable('provider_history_unavailable');}
}

export function findProviderCredit(history,receipt,amount,binding){
 if(history.state!=='available')return {state:'waiting',reason:history.reason};
 if(history.source!==historySource)return {state:'waiting',reason:'provider_credit_source_invalid'};
 const hash=receipt.transactionHash.toLowerCase();
 const records=history.items.filter(row=>[row.transaction_hash,row.tx_hash].some(value=>typeof value==='string'&&value.toLowerCase()===hash));
 if(records.length===0)return {state:'waiting',reason:'provider_credit_not_attributed'};
 // Ambiguous or conflicting references cannot quietly select the first row.
 if(records.length!==1)return {state:'waiting',reason:'provider_credit_ambiguous'};
 const row=records[0],references=[row.transaction_hash,row.tx_hash].filter(x=>x!==undefined&&x!==null);
 if(references.some(x=>typeof x!=='string'||x.toLowerCase()!==hash)||row.method!=='usdc_deposit'||row.adds_to!=='usdc'||row.amount_usdc!==amount||(row.status!==undefined&&!['credited','completed','confirmed','succeeded'].includes(row.status)))return {state:'waiting',reason:'provider_credit_conflict'};
 // Optional coordinates, when supplied, must agree with the actual transfer.
 if((row.chain_id!==undefined&&row.chain_id!==8453)||(row.to_address!==undefined&&String(row.to_address).toLowerCase()!==binding.address)||(row.from_address!==undefined&&String(row.from_address).toLowerCase()!==P.payer)||(row.token_address!==undefined&&String(row.token_address).toLowerCase()!==P.usdc8453))return {state:'waiting',reason:'provider_credit_conflict'};
 const credit={provider:'surplus',method:'usdc_deposit',id:row.id,transactionHash:hash,amountMicroUsdc:row.amount_usdc,address:binding.address,keyId:binding.keyId,chainId:8453,token:P.usdc8453,source:historySource,requestId:history.requestId,observedAt:history.observedAt,record:row};
 try{validateProviderCredit(credit,receipt,amount,binding);}catch{return {state:'waiting',reason:'provider_credit_invalid'};}
 return {state:'credited',credit};
}
