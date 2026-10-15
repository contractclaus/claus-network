import {Hono} from 'hono';
import {createHash} from 'node:crypto';
import {retainCompletion} from './retain-completion.js';
import {streamCompletion} from './completion-stream.js';
import {neon} from '@neondatabase/serverless';
import {privateKeyToAccount} from 'viem/accounts';
import {ExactEvmScheme} from '@x402/evm/exact/client';
import {UptoEvmScheme} from '@x402/evm/upto/client';
import {authorized,endpoint as inferenceEndpoint,validateRequest,validateChallenge,inferencePaymentSchemes} from '../vendor/src/policy.js';
import {requestBudget} from '../vendor/src/request-budget.js';
import {quoteWithinBudget} from '../vendor/src/quote.js';
import {imageEndpoint,imageRequest,normalizeImage,imageDailyLimit,imageQuoteLimit} from '../vendor/src/images.js';
import {inferenceFunding} from '../vendor/src/funding.js';
import {paymentOutcome,providerFailure} from '../vendor/src/outcomes.js';
import {responseMetadata,normalizeResponse,responseShape,completionTiming} from '../vendor/src/response.js';
import {inferenceFetch} from '../vendor/src/inference-transport.js';
import {createCompletion} from '../vendor/completion.js';
import {legacyStatus,legacyContinuity,operatorOrigin,validRequestId,unknown} from './legacy.js';
import {setupBudget,reservePayment,budgetSnapshot,confirmAbsent} from './budget.js';
import {reconcilePayment,reconcilePending} from './recovery.js';
import {recoveredBuilderResponse} from './builder-response-recovery.js';
import {createCreditCompletion} from './credit-provider.js';
import {readCredit,creditSnapshot} from './credit-store.js';
import {creditAllowed,creditCandidate,creditAdmission} from './credit-admission.js';
import * as creditWork from './credit-work-store.js';
import {workCandidate,workAdmission} from './credit-work-admission.js';
import {hasNonpaymentProof,reconcileCreditWork} from './credit-reconciliation.js';
import {reviewEvidence,recoverReviewBinding} from './review-evidence.js';
import {createOperatingResources} from './operating-resources.js';

export const payer='0xA46A89b5b3504C1c999696de8173ec9b2eB0a01a';
const forbidden=['DATABASE_URL','WALLET_SECRET','RELEASE_SECRET','WALLET_POLICY_SECRET','AGENT_POLICY_URL','CRON_SECRET','PRIVACY_SECRET','WEATHER_SCHEDULE_ID','LAB_RESEARCH_SECRET'];
export function paymentAccount(key,derive=privateKeyToAccount) {
  const account=derive(key);
  if(account?.address?.toLowerCase()!==payer.toLowerCase())throw Error('payment_wallet_mismatch');
  return account;
}
function configured(env) {
  return !!env.PAYMENT_DATABASE_URL&&!!env.SIGNER_PRIVATE_KEY&&
    [env.INFERENCE_SECRET,env.OPERATOR_SECRET,env.LEGACY_STATUS_SECRET].every(s=>typeof s==='string'&&s.length>=32)&&
    new Set([env.INFERENCE_SECRET,env.OPERATOR_SECRET,env.LEGACY_STATUS_SECRET]).size===3&&
    env.LEGACY_OPERATOR_URL===operatorOrigin&&env.INFERENCE_PAYMENT_SCHEME==='upto_only'&&
    /^\d{1,7}$/.test(env.MAX_INFERENCE_QUOTE_MICRO_USDC??'')&&BigInt(env.MAX_INFERENCE_QUOTE_MICRO_USDC)>0n&&
    BigInt(env.MAX_INFERENCE_QUOTE_MICRO_USDC)<=3000000n&&!forbidden.some(name=>!!env[name]);
}

// An outcome label alone is not final accounting. Expose zero only after the
// trusted canonical/unsigned verifier has committed its durable cost proof.
async function withNonpayment(db,id,result){
  if(result?.status!=='failed')return result;
  const [row]=await db`SELECT status,reserved_max::text,accounted_cost::text,cost_proof FROM claus_inference WHERE id=${id}`;
  const p=row?.cost_proof;
  const proven=p?.kind==='fenced_unsigned'&&p.payment==='not_signed'&&p.id===id&&p.fenced===true ||
    p?.kind==='expired_unused'&&p.payment==='not_settled'&&p.network==='eip155:8453'&&p.confirmation==='safe'&&/^0x[0-9a-f]{64}$/i.test(p.blockHash??'')&&/^\d+$/.test(p.blockNumber??'');
  return row?.status==='failed'&&row.accounted_cost==='0'&&proven
    ? {...result,accounting:{requestId:id,amount:'0',maximumMicroUsdc:row.reserved_max,basis:'verified_nonpayment'}} : result;
}

// Dependencies are constructed by the process, never from HTTP/model input.
export function createPaymentApp({env=process.env,database,deriveAccount=privateKeyToAccount,fetcher=fetch,paidFetch=inferenceFetch,
  funding=inferenceFunding,outcome=paymentOutcome,exactScheme=ExactEvmScheme,uptoScheme=UptoEvmScheme,
  reserve=reservePayment,reconcile=reconcilePayment,pending=reconcilePending,retain=retainCompletion}={}) {
  const app=new Hono();
  const sql=database??(()=>neon(env.PAYMENT_DATABASE_URL));
  const enabled=()=>env.PAYMENT_RELAY_ENABLED==='true';
  const resources=createOperatingResources({env,db:(strings,...values)=>sql()(strings,...values),request:fetcher});
  const creditLedgerEnabled=()=>!!env.SURPLUS_CREDIT_KEY_ID;
  const credit=createCreditCompletion({env,sql,fetcher,paidFetch});
  const independentCredit=createCreditCompletion({env,sql,fetcher,paidFetch,store:creditWork,forceStream:true,transportProfile:env.BUILDER_CREDIT_PROFILE});
  // Reviews retain the native Responses payload and model/effort. Builder's
  // optional Chat adapter must never reinterpret a review. Use the existing
  // native terminal-event parser so long responses establish the upstream
  // stream early. Streaming is not settlement: retain its full unknown hold.
  const reviewCredit=createCreditCompletion({env,sql,fetcher,paidFetch,store:creditWork,forceStream:true,allowSmallerOutput:false,allowCapacityDeferral:true,maximumOutputTokens:16384});
  const workHandler=id=>/^network-review:nr_[a-f0-9]{64}$/.test(id)?reviewCredit:independentCredit;
  const creditResult=row=>({status:row.status,response:row.response??null,outcome:row.outcome??null});
  const workResult=row=>({...creditResult(row),response:recoveredBuilderResponse(row)??row.response??null,id:row.id,rail:'surplus_credit',execution:{active:row.active,activeUntil:row.active_until},...((row.status==='failed'&&row.accounted_cost==='0'&&row.dispatched_at===null&&row.outcome?.payment==='not_signed')||hasNonpaymentProof(row)
    ?{accounting:{requestId:row.id,amount:'0',maximumMicroUsdc:row.reserved_max,basis:'verified_nonpayment'}}:{})});
  const workStatus=async(db,id)=>{const row=await creditWork.readCredit(db,id);if(!row)return null;await creditWork.expireCredit(db);return reconcileCreditWork(db,await creditWork.readCredit(db,id),{env,fetcher});};
  const recovery={payer,outcome};
  const completion=createCompletion({env,requestBudget,imageEndpoint,inferenceEndpoint,completionTiming,sql,imageRequest,validateRequest,imageQuoteLimit,imageDailyLimit,
    reserveInference:(db,args)=>reserve(db,{...args,networkMaximum:/^[1-9]\d{0,7}$/.test(env.NETWORK_COMPUTE_LIMIT_MICRO_USDC??'')?BigInt(env.NETWORK_COMPUTE_LIMIT_MICRO_USDC):0n}),afterInference:(db,id)=>reconcile(db,id,recovery),
    privateKeyToAccount:key=>paymentAccount(key,deriveAccount),address:payer,quoteWithinBudget,inferencePaymentSchemes:isImage=>inferencePaymentSchemes(isImage,'upto_only'),fetch:fetcher,
    inferenceFunding:requirement=>funding(requirement,undefined,payer),validateChallenge,UptoEvmScheme:uptoScheme,ExactEvmScheme:exactScheme,
    inferenceFetch:paidFetch,providerFailure,responseShape,responseMetadata,normalizeImage,normalizeResponse});
  app.get('/health',c=>c.json({ready:enabled()&&configured(env),payer,inferencePaymentScheme:'upto_only',supportedLifetimeLimitsMicroUsdc:['100000000','500000000','600000000'],
    configPresence:{enabled:enabled(),database:!!env.PAYMENT_DATABASE_URL,signing:!!env.SIGNER_PRIVATE_KEY,
      inference:!!env.INFERENCE_SECRET,operator:!!env.OPERATOR_SECRET,legacy:!!env.LEGACY_STATUS_SECRET&&env.LEGACY_OPERATOR_URL===operatorOrigin,
      billing:configured(env)}}));
  app.use('/api/*',async(c,next)=>{
    const path=c.req.path;
    let decodedPath='';try {decodedPath=decodeURIComponent(path);}catch { /* Refused below. */ }
    const payment=c.req.method==='POST'&&['/api/completion','/api/images'].includes(path);
    const setup=c.req.method==='POST'&&path==='/api/setup';
    const recovery=c.req.method==='POST'&&/^\/api\/reconcile\/[a-zA-Z0-9:_-]{1,160}$/.test(decodedPath);
    const status=c.req.method==='GET'&&decodedPath.startsWith('/api/requests/')&&validRequestId(decodedPath.slice('/api/requests/'.length));
    const admission=c.req.method==='GET'&&decodedPath.startsWith('/api/admission/')&&validRequestId(decodedPath.slice('/api/admission/'.length));
    const budget=c.req.method==='GET'&&path==='/api/budget';
    const resource=c.req.method==='GET'&&path==='/api/resources';
    const computeReceipt=c.req.method==='GET'&&/^\/api\/compute\/network-compute:[a-f0-9]{64}$/.test(decodedPath);
    const reviewReceipt=['GET','POST'].includes(c.req.method)&&/^\/api\/review-evidence\/[a-zA-Z0-9:_-]{1,160}$/.test(decodedPath);
    const computeId=payment?c.req.header('idempotency-key'):(status?decodedPath.slice('/api/requests/'.length):(admission?decodedPath.slice('/api/admission/'.length):computeReceipt?decodedPath.slice('/api/compute/'.length):''));
    const compute=/^network-compute:[a-f0-9]{64}$/.test(computeId??'');
    if(!payment&&!setup&&!recovery&&!status&&!budget&&!admission&&!computeReceipt&&!reviewReceipt&&!resource)return c.json({error:'payment_route_disabled'},403);
    if(!authorized(c.req.header('authorization'),reviewReceipt?env.PUBLISHER_REVIEW_SECRET:compute?env.NETWORK_COMPUTE_SECRET:setup||recovery||budget?env.OPERATOR_SECRET:env.INFERENCE_SECRET))return c.json({error:'unauthorized'},401);
    if(compute&&payment){
      if(path!=='/api/completion'||env.NETWORK_COMPUTE_ENABLED!=='true')return c.json({error:'compute_disabled',payment:'not_signed'},403);
      const b=await c.req.json().catch(()=>null);
      if(!b||b.model!==env.NETWORK_COMPUTE_MODEL||b.provider!=='openai'||b.tools?.length||b.max_output_tokens>4096||c.req.header('x-inference-purpose'))return c.json({error:'compute_profile_refused',payment:'not_signed'},400);
    }
    if(payment&&!enabled())return c.json({error:'payment_relay_disabled',payment:'not_signed'},503);
    if(payment||setup||recovery) {
      if(!configured(env))return c.json({error:'payment_configuration_refused',payment:'not_signed'},503);
      if(payment)try {paymentAccount(env.SIGNER_PRIVATE_KEY,deriveAccount);}catch {return c.json({error:'payment_wallet_mismatch',payment:'not_signed'},503);}
    }
    if(Number(c.req.header('content-length')??0)>(path==='/api/completion'||reviewReceipt?4200000:10000))return c.json({error:'request_too_large'},413);
    return await next();
  });
  app.post('/api/setup',async c=>{await setupBudget(sql());return c.json({ready:true,payer,budget:await budgetSnapshot(sql())});});
  app.get('/api/resources',async c=>{c.header('Cache-Control','no-store');return c.json(await resources());});
  app.get('/api/budget',async c=>c.json({...await budgetSnapshot(sql()),...(creditLedgerEnabled()?{prepaid:await creditSnapshot(sql())}:{})}));
  app.get('/api/review-evidence/:id',async c=>{
    c.header('Cache-Control','no-store');
    const row=await creditWork.readCredit(sql(),c.req.param('id'));
    if(!row)return c.json({error:'review_not_found'},404);
    const evidence=reviewEvidence(row,value=>recoveredBuilderResponse(value)??value.response);
    return evidence?c.json(evidence):c.json({error:'review_legacy_evidence_unavailable'},409);
  });
  app.post('/api/review-evidence/:id',async c=>{
    c.header('Cache-Control','no-store');
    const raw=await c.req.text();if(Buffer.byteLength(raw)>4200000)return c.json({error:'request_too_large'},413);
    let input;try{input=JSON.parse(raw);}catch{return c.json({error:'review_input_invalid'},400);}
    if(!input||Object.keys(input).sort().join(',')!=='maximumMicroUsdc,requestBodies')return c.json({error:'review_input_invalid'},400);
    const row=await creditWork.readCredit(sql(),c.req.param('id'));
    if(!row)return c.json({error:'review_not_found'},404);
    const originalBinding=recoverReviewBinding(row,input.requestBodies,input.maximumMicroUsdc);
    const evidence=reviewEvidence(row,value=>recoveredBuilderResponse(value)??value.response,originalBinding);
    return evidence?c.json(evidence):c.json({error:'review_original_request_unverified'},409);
  });
  app.get('/api/admission/:id',async c=>{
    const id=c.req.param('id'),maximumMicroUsdc=c.req.query('maximumMicroUsdc');
    c.header('Cache-Control','no-store');
    if(!/^[1-9]\d{0,6}$/.test(maximumMicroUsdc??'')||BigInt(maximumMicroUsdc)>3000000n)return c.json({error:'invalid_request_budget'},400);
    const waiting=reason=>({id,maximumMicroUsdc,ready:false,rail:creditCandidate(env,id)||workCandidate(env,id)?'surplus_credit':'x402',reason,retryAfterSeconds:60});
    if(!enabled()||!configured(env))return c.json(waiting('payment_unavailable'));
    try {
      const db=sql(),saved=await db`SELECT status FROM claus_inference WHERE id=${id}`;
      // Readiness never authorizes replay. Existing requests must use their
      // original POST/status semantics and can never switch rails here.
      if(saved.length)return c.json({id,maximumMicroUsdc,ready:true,rail:'x402'});
      const prepaid=await readCredit(db,id);
      if(prepaid)return c.json({id,maximumMicroUsdc,ready:true,rail:'surplus_credit'});
      if(await creditWork.readCredit(db,id))return c.json({id,maximumMicroUsdc,ready:true,rail:'surplus_credit'});
      if(workCandidate(env,id))return c.json(await workAdmission(db,env,id,maximumMicroUsdc));
      if(creditCandidate(env,id))return c.json(await creditAdmission(db,env,id,maximumMicroUsdc));
      const budget=await budgetSnapshot(db);
      return c.json(BigInt(budget.remaining)<BigInt(maximumMicroUsdc)?waiting('payment_budget_unavailable'):{id,maximumMicroUsdc,ready:true,rail:'x402'});
    } catch {return c.json(waiting('admission_unavailable'));}
  });
  app.post('/api/reconcile/:id',async c=>{
    {
      const existing=await readCredit(sql(),c.req.param('id'));
      if(existing)return c.json(creditResult(existing));
      const independent=await workStatus(sql(),c.req.param('id'));if(independent)return c.json(workResult(independent));
    }
    const result=await reconcile(sql(),c.req.param('id'),recovery);
    return result?c.json(result):c.json({error:'not_found'},404);
  });
  for(const path of ['/api/completion','/api/images'])app.post(path,async c=>{
    const id=c.req.header('idempotency-key');
    if(!validRequestId(id))return c.json({error:'stable_request_id_required'},400);
    const deliver=handler=>path==='/api/completion'&&c.req.header('x-inference-purpose')==='research'
      ?streamCompletion(()=>handler(c),work=>retain(work,c.env)):handler(c);
    const db=sql(),rows=await db`SELECT status FROM claus_inference WHERE id=${id}`;
    const savedCredit=await readCredit(db,id);
    if(savedCredit)return credit(c);
    if(await creditWork.readCredit(db,id))return workHandler(id)(c);
    if(!rows.length) {
      const legacy=await legacyStatus(id,{env,fetcher});
      if(legacy.kind==='found')return c.json({error:'legacy_request_read_only',id,...legacy.result},409);
      if(legacy.kind!=='absent')return c.json({error:'historical_request_unknown',id,...unknown()},409);
      const continuity=await legacyContinuity({env,fetcher});
      if(!continuity)return c.json({error:'legacy_not_frozen_and_drained',id,...unknown()},503);
      c.set('legacyContinuity',continuity);
      await pending(db,recovery);
    }
    // A rail belongs to the saved request. Old x402 IDs never become prepaid
    // requests. Only the explicit pilot or scoped Builder uses the allocation.
    // An unselected Builder waits; it never falls through to a paid x402 call.
    if(!rows.length&&workCandidate(env,id)&&path==='/api/completion'){
      if(c.req.header('x-inference-purpose')!=='research')return c.json({error:'credit_purpose_required',payment:'not_signed'},400);
      const admission=await workAdmission(db,env,id,c.req.header('x-max-quote-micro-usdc'));
      if(!admission.ready)return c.json({id,error:admission.reason,payment:'not_signed',admission:'deferred'},503);
      return deliver(workHandler(id));
    }
    if(!rows.length&&creditCandidate(env,id)&&path==='/api/completion') {
      if(c.req.header('x-inference-purpose')!=='research')return c.json({error:'credit_purpose_required',payment:'not_signed'},400);
      if(!creditAllowed(env,id))return c.json({error:'credit_pilot_wait',payment:'not_signed'},503);
      return deliver(credit);
    }
    return rows.length?completion(c):deliver(completion);
  });
  app.get('/api/compute/:id',async c=>{
    const id=c.req.param('id'),db=sql();
    if(!/^network-compute:[a-f0-9]{64}$/.test(id))return c.json({error:'not_found'},404);
    await reconcile(db,id,recovery);
    const [r]=await db`SELECT request_hash,status,response,accounted_cost::text,reserved_max::text,cost_proof FROM claus_inference WHERE id=${id}`;
    if(!r)return c.json({id,state:'unknown'},404);
    const proof=r.cost_proof,final=r.accounted_cost!==null&&!!proof&&['completed','failed'].includes(r.status);
    return c.json({id,requestHash:r.request_hash,status:r.status,response:r.response,
      accounting:final?{amount:r.accounted_cost,maximum:r.reserved_max,proofHash:'sha256:'+createHash('sha256').update(JSON.stringify(proof)).digest('hex'),final:true}:null});
  });
  app.get('/api/requests/:id',async c=>{
    const id=c.req.param('id');
    if(!env.PAYMENT_DATABASE_URL&&!database)return c.json(unknown());
    const db=sql(),rows=await db`SELECT status,response,outcome FROM claus_inference WHERE id=${id}`;
    {
      const existing=await readCredit(db,id);
      if(existing)return c.json(creditResult(existing));
      const independent=await workStatus(db,id);if(independent)return c.json(workResult(independent));
    }
    if(!rows.length) {
      const legacy=await legacyStatus(id,{env,fetcher});
      if(enabled()&&configured(env)&&legacy.kind==='absent'&&await legacyContinuity({env,fetcher})) {
        if(await confirmAbsent(db,id))return c.json({error:'not_found'},404);
        // A concurrent admission won the ID. Preserve its actual state; never
        // release the caller's reservation on a stale pre-network SELECT.
        const fresh=await db`SELECT status,response,outcome FROM claus_inference WHERE id=${id}`;
        if(fresh.length)return c.json(fresh[0]);
        {
          const freshCredit=await readCredit(db,id);
          if(freshCredit)return c.json(creditResult(freshCredit));
          const freshWork=await workStatus(db,id);if(freshWork)return c.json(workResult(freshWork));
        }
      }
      return c.json(legacy.result);
    }
    if(enabled()&&configured(env))return c.json(await withNonpayment(db,id,await reconcile(db,id,recovery)??unknown()));
    return c.json({status:rows[0].status,response:rows[0].response??null,outcome:rows[0].outcome??null});
  });
  app.onError((_,c)=>c.json({error:'payment_service_unavailable',...unknown()},503));
  return app;
}
export default createPaymentApp();
