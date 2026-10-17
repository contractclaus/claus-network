import {createHash} from 'node:crypto';
import {ExactEvmScheme} from '@x402/evm/exact/client';
import {privateKeyToAccount} from 'viem/accounts';
import {reservePayment} from './budget.js';
import {reconcilePayment} from './recovery.js';
import {inferenceFunding} from '../vendor/src/funding.js';

export const servicePayer='0xA46A89b5b3504C1c999696de8173ec9b2eB0a01a';
const usdc='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const payTo='0x6d6E695b09861467c7d462f5AAF31cF3540B9192';
const specs={exa_search:{url:'https://api.exa.ai/search',maximum:20000},exa_contents:{url:'https://api.exa.ai/contents',maximum:20000}};
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const check=(v,code)=>{if(!v)throw Error('external_service_'+code);};
export function serviceRequest(input){
 check(input&&Object.keys(input).every(k=>['service','arguments'].includes(k))&&Object.hasOwn(specs,input.service),'input_invalid');
 const a=input.arguments;check(a&&typeof a==='object'&&!Array.isArray(a),'input_invalid');
 if(input.service==='exa_search'){
  check(Object.keys(a).every(k=>['query','numResults','type'].includes(k))&&typeof a.query==='string'&&a.query.trim()&&a.query.length<=1000&&['auto','fast','instant'].includes(a.type??'auto')&&Number.isInteger(a.numResults??5)&&(a.numResults??5)>0&&(a.numResults??5)<=10,'input_invalid');
  return {spec:specs[input.service],body:{query:a.query,numResults:a.numResults??5,type:a.type??'auto'}};
 }
 check(Object.keys(a).every(k=>['urls'].includes(k))&&Array.isArray(a.urls)&&a.urls.length>0&&a.urls.length<=10,'input_invalid');
 for(const raw of a.urls){let u;try{u=new URL(raw);}catch{}check(u&&u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&u.hostname.includes('.')&&!/(^localhost$|\.local$|^127\.|^10\.|^192\.168\.|^169\.254\.|:)/i.test(u.hostname),'url_invalid');}
 return {spec:specs[input.service],body:{urls:a.urls,text:true}};
}
export function serviceChallenge(challenge,spec){
 check(challenge?.x402Version===2&&challenge.resource?.url===spec.url,'resource_mismatch');
 const q=challenge.accepts?.find(q=>q.scheme==='exact'&&q.network==='eip155:8453'&&q.asset?.toLowerCase()===usdc.toLowerCase()&&q.payTo?.toLowerCase()===payTo.toLowerCase()&&q.extra?.name==='USD Coin'&&q.extra?.version==='2'&&(!q.extra.assetTransferMethod||q.extra.assetTransferMethod==='eip3009'));
 check(q&&/^\d+$/.test(q.amount)&&BigInt(q.amount)>0n&&BigInt(q.amount)<=BigInt(spec.maximum)&&Number.isInteger(q.maxTimeoutSeconds)&&q.maxTimeoutSeconds>0&&q.maxTimeoutSeconds<=120,'quote_refused');return q;
}
async function json(response,maximum=300000){const reader=response.body?.getReader();check(reader,'empty_response');const chunks=[];let size=0;try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;check(size<=maximum,'response_size');chunks.push(part.value);}return JSON.parse(Buffer.concat(chunks).toString());}finally{reader.releaseLock();}}
export function createExternalServices({db,env=process.env,request=fetch,reserve=reservePayment,reconcile=reconcilePayment,funding=inferenceFunding,derive=privateKeyToAccount,Scheme=ExactEvmScheme}={}){
 const quote=async input=>{const {spec,body}=serviceRequest(input),r=await request(spec.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});check(r.status===402,'quote_unavailable');let challenge;const h=r.headers.get('payment-required');if(h){check(h.length<64000,'quote_size');challenge=JSON.parse(Buffer.from(h,'base64'));await r.body?.cancel();}else challenge=await json(r,48000);return {spec,body,challenge,requirement:serviceChallenge(challenge,spec)};};
 return {
  catalog:()=>({services:Object.entries(specs).map(([id,s])=>({id,url:s.url,maximumMicroUsdc:String(s.maximum),scheme:'exact',network:'eip155:8453'})),accounting:'existing-operating-budget',automaticRetry:false}),
  async quote(input){const q=await quote(input);return {service:input.service,url:q.spec.url,amountMicroUsdc:q.requirement.amount,maximumMicroUsdc:String(q.spec.maximum),payTo:q.requirement.payTo,quotedAt:new Date().toISOString(),payment:'not_signed'};},
  async status(id){check(/^external-service:[a-f0-9]{64}$/.test(id),'id_invalid');await reconcile(db,id,{payer:servicePayer}).catch(()=>{});const [row]=await db`SELECT status,response,outcome,reserved_max::text,accounted_cost::text FROM claus_inference WHERE id=${id}`;return row?{id,...row,replay:false}:{id,state:'not_found'};},
  async call(id,input){
   check(/^external-service:[a-f0-9]{64}$/.test(id),'id_invalid');const parsed=serviceRequest(input),binding=hash({service:input.service,body:parsed.body});
   const [old]=await db`SELECT request_hash,status,response FROM claus_inference WHERE id=${id}`;
   if(old){check(old.request_hash===binding,'id_conflict');return {id,status:old.status,response:old.response??null,replay:false};}
   const rows=await reserve(db,{id,hash:binding,maximum:String(parsed.spec.maximum),isImage:false,activeMs:180000});check(rows.length,'reservation_unavailable');
   let signed=false,stage='quote';
   try{
    const q=await quote(input),account=derive(env.SIGNER_PRIVATE_KEY);check(account.address.toLowerCase()===servicePayer.toLowerCase(),'payer_mismatch');
    stage='funding';check((await funding(q.requirement,undefined,servicePayer)).sufficient,'funding_required');
    const claimed=await db`UPDATE claus_inference SET status='authorizing' WHERE id=${id} AND status='reserved' AND (outcome->>'activeUntil')::timestamptz>now() RETURNING id`;check(claimed.length,'reservation_fenced');
    // Once signing starts an exception is uncertain, even if the signer throws.
    stage='signing';signed=true;
    const payload=await new Scheme(account).createPaymentPayload(2,q.requirement),payment={...payload,accepted:q.requirement,resource:q.challenge.resource};
    const saved=await db`UPDATE claus_inference SET status='signed',payment_payload=${JSON.stringify(payment)}::jsonb WHERE id=${id} AND status='authorizing' RETURNING id`;check(saved.length,'authorization_fenced');
    stage='provider_request';const r=await request(q.spec.url,{method:'POST',headers:{'content-type':'application/json','payment-signature':Buffer.from(JSON.stringify(payment)).toString('base64')},body:JSON.stringify(q.body),redirect:'error',signal:AbortSignal.timeout(45000)});
    check(r.ok,'paid_response_unavailable');stage='provider_body';const body=await json(r),raw=r.headers.get('payment-response');let receipt=null;if(raw&&raw.length<=8192){try{receipt=JSON.parse(Buffer.from(raw,'base64'));}catch{}}
    const response={service:input.service,body,receipt,instructionAuthority:false};
    stage='recording_response';const finished=await db`UPDATE claus_inference SET status='completed',response=${JSON.stringify(response)}::jsonb,outcome=jsonb_build_object('providerResponseReceived',true,'service',${input.service}::text) WHERE id=${id} AND status='signed' RETURNING id`;check(finished.length,'receipt_fenced');
    await reconcile(db,id,{payer:servicePayer}).catch(()=>{});return {id,status:'completed',response};
   }catch(error){
    const reason=/^external_service_[a-z_]+$/.test(error?.message??'')?error.message:'external_service_outcome_unknown';
    await db`UPDATE claus_inference SET status=${signed?'uncertain':'failed'},outcome=${JSON.stringify({failure:reason,stage,...(!signed?{payment:'not_signed'}:{})})}::jsonb WHERE id=${id} AND status IN ('reserved','authorizing','signed')`;
    await reconcile(db,id,{payer:servicePayer}).catch(()=>{});return {id,status:signed?'uncertain':'failed',reason,replay:false};
   }
  }
 };
}
