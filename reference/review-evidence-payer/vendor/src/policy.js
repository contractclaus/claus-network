import {validateText} from './structured-format.js';
import { timingSafeEqual } from 'node:crypto';
export const endpoint='https://api.surplusintelligence.ai/v1/responses';
export const address='0xBb145cA83272c3806D4dDc75cA1D5514789cF1C5';
export const usdc='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
// Operator-selected payment rail; callers cannot override it in a model request.
export function inferencePaymentSchemes(isImage=false,preference=process.env.INFERENCE_PAYMENT_SCHEME??'upto') {
  if(!['upto','upto_only','exact'].includes(preference))throw new Error('invalid_inference_payment_scheme');
  return isImage||preference==='exact'?['exact']:preference==='upto_only'?['upto']:['upto','exact'];
}
export function authorized(header,secret) {
  if(!header||!secret||secret.length<32)return false;
  const a=Buffer.from(header),b=Buffer.from(`Bearer ${secret}`);
  return a.length===b.length&&timingSafeEqual(a,b);
}
export function validateRequest(request) {
  const output=request?.max_output_tokens;
  validateText(request?.text);
  if(typeof request?.model!=='string'||!/^gpt-[a-z0-9.-]{1,80}$/.test(request.model)||request.provider!=='openai'||typeof request.stream!=='boolean'||request.store!==false||!Array.isArray(request.input)||request.input.length<1||request.input.length>160||!Number.isInteger(output)||output<1||output>8192)throw new Error('request_refused');
  if(!request.reasoning||!['low','medium','high','xhigh','max'].includes(request.reasoning.effort)||request.reasoning.context!=='all_turns'||Object.keys(request.reasoning).some(k=>!['effort','context'].includes(k)))throw new Error('invalid_reasoning_effort');
  if(Buffer.byteLength(JSON.stringify(request))>4200000)throw new Error('request_too_large');
  const allowed=new Set(['model','provider','input','instructions','max_output_tokens','reasoning','store','stream','tools','tool_choice','parallel_tool_calls','text']);
  if(Object.keys(request).some(k=>!allowed.has(k)))throw new Error('unsupported_request_field');
}
export function validateChallenge(challenge,maxMicro=1000000n,schemes=['upto','exact'],expectedEndpoint=endpoint) {
  if(![endpoint,'https://api.surplusintelligence.ai/v1/images/generations','https://api.surplusintelligence.ai/v1/chat/completions'].includes(expectedEndpoint)||challenge.x402Version!==2||challenge.resource?.url!==expectedEndpoint)throw new Error('wrong_payment_resource');
  const req=schemes.map(scheme=>challenge.accepts?.find(r=>r.scheme===scheme&&r.network==='eip155:8453'&&r.asset?.toLowerCase()===usdc.toLowerCase())).find(Boolean);
  if(!req||!/^0x[0-9a-fA-F]{40}$/.test(req.payTo)||BigInt(req.payTo)===0n)throw new Error('invalid_recipient');
  if(req.extra?.name!=='USD Coin'||req.extra?.version!=='2')throw new Error('wrong_signing_domain');
  if(req.scheme==='exact'&&req.extra?.assetTransferMethod&&req.extra.assetTransferMethod!=='eip3009')throw new Error('wrong_signing_domain');
  if(req.scheme==='upto'&&(!/^0x[0-9a-fA-F]{40}$/.test(req.extra?.facilitatorAddress)||BigInt(req.extra.facilitatorAddress)===0n||req.extra.assetTransferMethod&&req.extra.assetTransferMethod!=='permit2'))throw new Error('wrong_signing_domain');
  if(!/^\d+$/.test(req.amount)||BigInt(req.amount)<=0n||BigInt(req.amount)>maxMicro)throw new Error('quote_refused');
  if(!Number.isInteger(req.maxTimeoutSeconds)||req.maxTimeoutSeconds<1||req.maxTimeoutSeconds>120)throw new Error('invalid_payment_lifetime');
  return req;
}
