import {createHash} from 'node:crypto';
import {endpoint,validateRequest} from '../vendor/src/policy.js';
import {requestBudget} from '../vendor/src/request-budget.js';
import {quoteWithinBudget} from '../vendor/src/quote.js';
import {completionTiming,normalizeResponse,responseShape} from '../vendor/src/response.js';
import {inferenceFetch,inferenceTrace} from '../vendor/src/inference-transport.js';
import * as creditStore from './credit-store.js';
import {readResponseStream} from './response-stream.js';
import {builderTransport,normalizeBuilderChat,readBuilderResponse} from './builder-transport.js';

const balanceEndpoint='https://api.surplusintelligence.ai/v1/payments/balance';
const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9_:-]{1,160}$/.test(value);
function micro(value) {
  if(typeof value==='number')return Number.isSafeInteger(value)&&value>=0?BigInt(value):null;
  return typeof value==='string'&&/^\d{1,16}$/.test(value)&&BigInt(value)<=BigInt(Number.MAX_SAFE_INTEGER)?BigInt(value):null;
}
function actualCost(header,result) {
  const usage=result?.usage;
  const hasBody=usage!==null&&typeof usage==='object'&&Object.hasOwn(usage,'buyer_cost_micro');
  const hasHeader=header!==null;
  const a=hasHeader?micro(header):null,b=hasBody?micro(usage.buyer_cost_micro):null;
  if((hasHeader&&a===null)||(hasBody&&b===null)||(hasHeader&&hasBody&&a!==b))return null;
  return hasHeader?a:hasBody?b:null;
}

// This lane consumes the store's existing finite escrow. An unsigned quote is
// only an estimate/filter, not a signed spending ceiling. No x402 signing,
// top-up, fallback, retry or provider recovery request belongs here.
export function createCreditCompletion({env,sql,fetcher=fetch,paidFetch=inferenceFetch,store=creditStore,forceStream,transportProfile}) {
  return async function creditCompletion(c) {
    const id=c.req.header('idempotency-key');
    if(!validId(id))return c.json({error:'stable_request_id_required'},400);
    let request,budget;
    try {
      const raw=await c.req.text();
      if(Buffer.byteLength(raw)>4200000)return c.json({error:'request_too_large',payment:'not_signed'},413);
      request=JSON.parse(raw);validateRequest(request);
    } catch {return c.json({error:'request_refused',payment:'not_signed'},400);}
    try {
      const configured=BigInt(env.MAX_INFERENCE_QUOTE_MICRO_USDC??'3000000');
      if(configured<=0n)throw Error();
      budget=requestBudget(JSON.stringify(request),configured<3000000n?configured:3000000n,c.req.header('x-max-quote-micro-usdc'));
    } catch {return c.json({error:'invalid_request_budget',payment:'not_signed'},400);}
    const {hash,maximum:callerMaximum}=budget,db=sql();
    const existing=await store.readCredit(db,id);
    if(existing) {
      if(existing.request_hash!==hash)return c.json({error:'request_id_conflict'},409);
      return existing.status==='completed'?c.json(existing.response):c.json({error:'payment_requires_reconciliation',id},409);
    }
    let transport;
    try {if(transportProfile)transport=builderTransport(request,transportProfile);}
    catch {return c.json({error:'builder_transport_request_refused',payment:'not_signed'},400);}
    const target=transport?.endpoint??endpoint;
    const key=env.SURPLUS_CREDIT_KEY;
    if(typeof key!=='string'||!/^inf_[0-9a-f]{32}$/.test(key))return c.json({error:'credit_not_configured',payment:'not_signed'},503);
    const pool=await store.creditSnapshot(db);
    if(!pool||pool.state!=='funded'||pool.allocated!=='2000000'||pool.key_id!==env.SURPLUS_CREDIT_KEY_ID||!/^0x[0-9a-f]{40}$/i.test(pool.deposit_address??''))return c.json({error:'credit_binding_unavailable',payment:'not_signed'},503);
    const maximum=micro(pool.remaining);
    if(maximum===null||maximum<=0n)return c.json({error:'request_already_reserved'},409);
    if(maximum>callerMaximum)return c.json({error:'credit_exposure_exceeds_request',payment:'not_signed'},503);
    // Even a provider that reflects authorization into its result cannot cause
    // this credential to enter the saved result, operator outcome or agent.
    const redact=value=>JSON.parse(JSON.stringify(value).split(key).join('[redacted]'));
    const timing=transport??completionTiming(false,'research'),started=Date.now(),deadline=started+timing.activeMs;
    const reserved=await store.reserveCredit(db,{id,hash,maximum,activeMs:timing.activeMs,binding:{address:pool.deposit_address,keyId:pool.key_id,transaction:pool.deposit_tx,
      ...(transport?{transport:{profile:transport.profile,endpoint:target,provider:'openrouter',model:request.model,effort:transport.request.reasoning_effort}}:{})}});
    if(!reserved.length)return c.json({error:'request_already_reserved'},409);
    let submitting=false,providerRequestId=null,httpStatus=null,providerSignal=null;
    let providerResponse=null,terminalStage=null;
    const streamed=transport?transport.streamed:forceStream??env.SURPLUS_CREDIT_STREAM==='true';
    let outcome={rail:'surplus_credit',failure:'credit_preflight_failed'};
    const signal=limit=>{
      const remaining=Math.min(limit,deadline-Date.now()-30000);
      if(remaining<=0)throw Error('request_deadline_reached');
      return AbortSignal.timeout(Math.floor(remaining));
    };
    try {
      outcome={rail:'surplus_credit',failure:'credit_quote_rejected'};
      // The caller's identity/hash remains unchanged. Only this operator-owned
      // credit transport changes; the quote and durable wire hash use the same
      // exact streamed request. x402 and old saved requests are unaffected.
      const quoted=await quoteWithinBudget(transport?.request??(streamed?{...request,stream:true}:request),{maximum,schemes:['upto'],endpoint:target,allowSmallerOutput:!transport,fetchQuote:async candidate=>{
        const response=await fetcher(target,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify(candidate),signal:signal(20000)});
        if(response.status!==402)throw Error('quote_rejected');
        return response.json();
      }});
      outcome={rail:'surplus_credit',failure:'credit_balance_unavailable'};
      const get=async route=>{
        const r=await fetcher('https://api.surplusintelligence.ai/v1/payments/'+route,{method:'GET',redirect:'error',headers:{Authorization:`Bearer ${key}`},signal:signal(20000)});
        if(!r.ok)throw Error('account_read_rejected');return r.json();
      };
      const balance=await get('balance'),topup=await get('auto-topup'),deposit=await get('deposit-address');
      const available=typeof balance?.credit_balance_usdc==='string'?micro(balance.credit_balance_usdc):null;
      if(balance?.account_status!=='active'||balance.prefunded_usdc_enabled!==true||topup?.enrolled!==false||available===null||available<BigInt(quoted.requirement.amount)||available>maximum||balance.usdc_available_usdc!==String(available)||balance.allowance_usdc!=='0'||balance.usdc_held_usdc!=='0'||balance.fiat_held_usdc!=='0'||balance.pending_deposit_usdc!=='0'||deposit?.chain_id!==8453||String(deposit?.address).toLowerCase()!==pool.deposit_address.toLowerCase()||String(deposit?.token_address).toLowerCase()!=='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')throw Error('balance_rejected');
      outcome={rail:'surplus_credit',failure:'reservation_fenced'};
      // Check the local conservative deadline before the atomic DB lease fence.
      signal(timing.providerMs);
      // A lost DB acknowledgement might have committed submitting; hold it.
      submitting=true;
      const payloadHash=createHash('sha256').update(JSON.stringify(quoted.request)).digest('hex');
      // Persist our correlation before dispatch; a timeout can lose every
      // response header. This is not a provider receipt or settlement proof.
      const clientRequestId='claus-'+createHash('sha256').update(JSON.stringify([id,hash,payloadHash])).digest('hex');
      if(!await store.startCredit(db,id,payloadHash,clientRequestId)) {submitting=false;throw Error('reservation_fenced');}
      outcome={rail:'surplus_credit',failure:'provider_response_not_received'};
      providerSignal=signal(transport?.providerMs??timing.providerMs);
      const response=providerResponse=await paidFetch(target,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`,'x-request-id':clientRequestId},body:JSON.stringify(quoted.request),signal:providerSignal});
      // Save only the allowlisted ID and numeric status before reading a body
      // (or any other header), which may fail after a real provider charge.
      httpStatus=Number.isInteger(response.status)&&response.status>=100&&response.status<=599?response.status:null;
      const returnedId=response.headers.get('x-request-id');
      providerRequestId=validId(returnedId)&&!returnedId.includes(key)?returnedId:null;
      outcome={rail:'surplus_credit',failure:'provider_response_unreadable',providerRequestId,httpStatus};
      if(!await store.recordCreditHeaders(db,id,{requestId:providerRequestId,httpStatus}))throw Error('headers_fenced');
      if(!response.ok)throw Error('provider_http_error');
      const costHeader=response.headers.get('x-si-buyer-cost-micro');
      const truncated=response.headers.get('x-si-truncated')==='1';
      if(streamed){
        outcome={...outcome,failure:'provider_stream_unfinished',responseTransport:'sse'};
        if(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='text/event-stream')throw Error('stream_content_type');
      }
      const collected=streamed?await readResponseStream(response,{model:request.model,signal:providerSignal}):null;
      const result=collected?collected.result:transport?await readBuilderResponse(response):await response.json();
      // A streamed header freezes before settlement. Do not treat it, or a
      // token-usage estimate, as the final credit charge. Keep the reservation
      // until a separately verified request-bound billing record is available.
      const amount=streamed?null:actualCost(costHeader,result);
      outcome={...outcome,failure:'provider_response_invalid',...responseShape(result)};
      const payment=amount===null?'unknown':amount===0n?'not_settled':'settled';
      outcome={rail:'surplus_credit',payment,providerRequestId,httpStatus,...responseShape(result),...(transport?{builderResponseShape:{choiceCount:Array.isArray(result?.choices)?result.choices.length:null,finishReason:['stop','length','tool_calls','content_filter'].includes(result?.choices?.[0]?.finish_reason)?result.choices[0].finish_reason:'other',contentKind:result?.choices?.[0]?.message?.content===null?'null':typeof result?.choices?.[0]?.message?.content,contentBytes:typeof result?.choices?.[0]?.message?.content==='string'?Buffer.byteLength(result.choices[0].message.content):0}}:{}),...(collected?{responseTransport:'sse',responseBytes:collected.bytes,responseEvents:collected.events}:{})};
      if(amount!==null&&amount>maximum) {
        // The store freezes the allocation on overage; never cache success.
        await store.finishCredit(db,id,{status:'uncertain',response:null,outcome:{...outcome,failure:'credit_cost_exceeds_maximum',actualMicroUsdc:String(amount)},amount:String(amount)});
        return c.json({error:'payment_requires_reconciliation',id},502);
      }
      terminalStage='response_normalization';
      const normalized=transport?normalizeBuilderChat(result,request.model,response.headers,quoted.request.max_completion_tokens):normalizeResponse(result,request.model);
      if(transport){
        // Builder returns JSON inside a message string. Decode that envelope
        // using the same fence handling as Builder before redaction. Incomplete
        // or invalid source cannot escape, but its received bill is retained.
        const content=normalized.choices[0].message.content.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
        let source;
        if(normalized.responseStatus==='completed'){
          try{source=JSON.stringify(redact(JSON.parse(content)));}catch{outcome.failure='invalid_source_json';}
        }
        if(source===undefined){
          normalized.responseStatus='incomplete';normalized.choices[0].finish_reason='length';
          normalized.choices[0].message.content='';
        }else normalized.choices[0].message.content=source;
      }
      // SI can report a deadline cut only in the transport header even when
      // the Responses body says completed. Keep its cost, reject its output.
      if(truncated){normalized.responseStatus='incomplete';normalized.choices[0].finish_reason='length';}
      const safe=redact({...normalized,receipt:{scheme:'surplus_credit',requestId:id,providerRequestId,actualMicroUsdc:amount===null?null:String(amount)},telemetry:{paymentScheme:'surplus_credit',actualMicroUsdc:amount===null?null:String(amount),latencyMs:Date.now()-started,requestedMaxOutputTokens:request.max_output_tokens,effectiveMaxOutputTokens:transport?(normalized.tokenLimitAdapted?null:quoted.request.max_completion_tokens):quoted.request.max_output_tokens,...(transport?{upstreamRequestedMaxCompletionTokens:quoted.request.max_completion_tokens,tokenLimitAdapted:normalized.tokenLimitAdapted}:{}),requestedInputItems:request.input.length,effectiveInputItems:transport?request.input.length:quoted.request.input.length,...(transport?{transportProfile:transport.profile,provider:'openrouter',requestedModel:request.model,effectiveModel:transport.request.model,requestedReasoningEffort:request.reasoning.effort,effectiveReasoningEffort:transport.request.reasoning_effort}:{}),...(collected?{responseTransport:'sse',responseBytes:collected.bytes,responseEvents:collected.events}:{})}});
      terminalStage='result_persistence';
      if(!await store.finishCredit(db,id,{status:'completed',response:safe,outcome:redact(outcome),amount:amount===null?null:String(amount)}))throw Error('result_fenced');
      return c.json(safe);
    } catch(error) {
      // Neither HTTP 402 nor a timeout proves that a credit POST was unpaid.
      // A failed terminal CAS must not overwrite another handler's decision.
      const failure=redact({...outcome,...(terminalStage?{failure:terminalStage}:{}),payment:submitting?'unknown':'not_signed',providerRequestId,httpStatus});
      const trace=inferenceTrace(error)??inferenceTrace(providerResponse);
      if(trace)failure.transport=trace;
      if(['TimeoutError','AbortError','SyntaxError','TypeError'].includes(error?.name))failure.errorType=error.name;
      if(['UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_CONNECT_TIMEOUT','ECONNRESET'].includes(error?.cause?.code))failure.transportCode=error.cause.code;
      await store.finishCredit(db,id,{status:submitting?'uncertain':'failed',response:null,outcome:failure,amount:submitting?null:'0'}).catch(()=>{});
      return c.json({error:'payment_requires_reconciliation',id},502);
    } finally {
      // Stop an unread body after a header/CAS/HTTP failure as well. The SSE
      // reader releases its lock itself; cancellation must never delay a save.
      try {if(providerResponse?.body&&!providerResponse.body.locked)void providerResponse.body.cancel().catch(()=>{});}catch{}
    }
  };
}
