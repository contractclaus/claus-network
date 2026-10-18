import {installInfrastructureRoutes} from './infrastructure/routes.mjs';
import {installOciRoutes} from './github/oci-routes.mjs';
import {installGithubRoutes} from './github/routes.mjs';
import {installRuntimeGuardian} from './runtime-guardian.mjs';
import {installPartnerGateway} from './partner-launch/routes.mjs';
import {installCapitalRoutes} from './capital/routes.mjs';
import {installFundingRoutes} from './compute-funding/service.mjs';
import {installSearchRoutes} from './search/routes.js';
import {installSocialRoutes} from './social/routes.js';
import {installConfigurationRoutes} from './configuration/routes.js';
import {installPublisherRoutes} from './publisher/routes.js';
import {installWebsiteAdmin} from './website-admin/routes.mjs';
import {installSurfacePublisherRoutes} from './surface-publisher/routes.js';
import {installProgramRoutes} from './programs/routes.js';
import {installJobsRoutes} from './jobs-wallet/routes.js';
import {researchPayments,setupResearchPayments} from './lab-routes.js';
import {requestBudget} from './request-budget.js';
import {reserveInference} from './inference-journal.js';
import {readContinuity} from './inference-freeze.js';
import { Hono } from 'hono';
import { neon } from '@neondatabase/serverless';
import { createHash } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { UptoEvmScheme } from '@x402/evm/upto/client';
import { endpoint as inferenceEndpoint,address,authorized,validateRequest,validateChallenge,inferencePaymentSchemes } from './policy.js';
import {quoteWithinBudget} from './quote.js';
import {imageEndpoint,imageRequest,normalizeImage,imageDailyLimit,imageQuoteLimit} from './images.js';
import { paymentOutcome, providerFailure } from './outcomes.js';
import { inferenceFunding } from './funding.js';
import {productionWallet} from './wallet.js';
import {initializeWallet,walletRepository} from './wallet-store.js';
import {stableId} from './wallet-policy.js';
import { responseMetadata,requestMayBeActive,normalizeResponse,responseShape,completionTiming } from './response.js';
import {inferenceFetch} from './inference-transport.js';
import {relayWeather} from './weather.js';
import {processLiquidity} from './liquidity.js';
import {processOrdinaryBuybacks} from './ordinary-buybacks.js';
import {processNfts,nftMaintenanceConfiguration} from './nfts.js';
import {processNftStaking,nftStakingConfiguration} from './nft-staking.js';
import {processLpRewards,lpRewardsConfiguration} from './lp-rewards.js';
import {processPredictions,predictionMaintenanceConfiguration} from './predictions.js';
import {predictionDeploymentPreflight} from './prediction-preflight.js';
import {processArbitrage,arbitrageConfiguration} from './arbitrage.js';
import {processBuybacks,buybackConfiguration} from './arbitrage-buyback.js';
import {arbitragePreflight} from './arbitrage-preflight.js';
import {privacyRelay,privacyConfiguration} from './privacy.js';

export function createSignerApp({database}={}) {
const app=new Hono();
  installFundingRoutes(app,'signer');
const sql=database??(()=>{if(!process.env.DATABASE_URL)throw new Error('database_missing');return neon(process.env.DATABASE_URL);});
const afterInference=async()=>{};
app.get('/health',c=>c.json(process.env.SERVICE_ROLE==='operator'
  ? {ready:!!process.env.DATABASE_URL&&!!process.env.SIGNER_PRIVATE_KEY,payer:address,scope:'fixed_operator_with_legacy_observer',inferencePayments:false,labResearch:process.env.OPERATOR_LAB_ENABLED==='true',configPresence:{database:!!process.env.DATABASE_URL,signing:!!process.env.SIGNER_PRIVATE_KEY,legacyStatus:!!process.env.LEGACY_STATUS_SECRET}}
  : {service:'claus-inference',databaseConfigured:!!process.env.DATABASE_URL,signingConfigured:!!process.env.SIGNER_PRIVATE_KEY,scope:'inference_and_policy_gated_wallet',transactionSigning:!!process.env.WALLET_SECRET&&!!process.env.WALLET_POLICY_SECRET,inferencePaymentScheme:inferencePaymentSchemes()[0],maximumInferenceQuoteMicroUsdc:process.env.MAX_INFERENCE_QUOTE_MICRO_USDC??'1000000'}));
app.use('/api/*',async(c,next)=>{
  if(c.req.method==='POST'&&['/api/oci-builds','/api/infrastructure'].includes(c.req.path)||c.req.method==='GET'&&c.req.path==='/api/infrastructure/guardian')return next();
  if(c.req.path==='/api/runtime/guardian'||c.req.path==='/api/github'||c.req.path==='/api/partner-launch'||c.req.path==='/api/capital'||c.req.path==='/api/search'||c.req.path==='/api/search/status'||c.req.path==='/api/social'||/^\/api\/social\/receipts\/[a-zA-Z0-9_.:%-]+$/.test(c.req.path)||(c.req.path==='/api/native-missions'||/^\/api\/native-missions\/[a-zA-Z0-9_.:%-]+$/.test(c.req.path)||c.req.path==='/api/native-configuration'||/^\/api\/native-configuration\/[0-9]+$/.test(c.req.path))||c.req.path.startsWith('/api/jobs/')||c.req.path==='/api/programs'||c.req.path==='/api/publisher'||c.req.path==='/api/website-admin'||c.req.path==='/api/repository-publisher'||c.req.path==='/api/surface-publisher')return next();
  // Explicit opt-in only: retain the historical default until manual migration.
  // This gate precedes authentication selection, body parsing and all handlers.
  if(process.env.SERVICE_ROLE==='operator') {
    let decodedPath='';try {decodedPath=decodeURIComponent(c.req.path);}catch { /* Invalid IDs are refused. */ }
    const legacy=c.req.method==='GET'&&(/^\/api\/requests\/[a-zA-Z0-9:_-]{1,160}$/.test(decodedPath)||decodedPath==='/api/legacy/continuity');
    const recovery=c.req.method==='POST'&&/^\/api\/reconcile\/[a-zA-Z0-9:_-]{1,160}$/.test(decodedPath);
    const lab=process.env.OPERATOR_LAB_ENABLED==='true'&&(
      c.req.method==='POST'&&decodedPath==='/api/lab/payments'
      ||c.req.method==='GET'&&/^\/api\/lab\/payments\/[a-zA-Z0-9:_-]{1,160}$/.test(decodedPath)
      ||c.req.method==='POST'&&/^\/api\/lab\/payments\/[a-zA-Z0-9:_-]{1,160}\/(submit|reconcile)$/.test(decodedPath));
    const fixed=c.req.method==='GET'&&['/api/lp-rewards/process','/api/lp-rewards/status','/api/nft-staking/process','/api/nft-staking/status','/api/weather/relay','/api/liquidity/process','/api/ordinary-buybacks/process','/api/nfts/process','/api/nfts/status','/api/predictions/process','/api/predictions/status','/api/predictions/preflight','/api/arbitrage/process','/api/arbitrage/status','/api/arbitrage/preflight','/api/arbitrage/buybacks','/api/arbitrage/buyback-status','/api/privacy/configuration'].includes(c.req.path)
      ||c.req.method==='POST'&&['/api/privacy/fees','/api/privacy/quote','/api/privacy/submit','/api/privacy/status'].includes(c.req.path);
    if(!legacy&&!fixed&&!recovery&&!lab)return c.json({error:'operator_route_disabled'},403);
    if(legacy) {
      if(!authorized(c.req.header('authorization'),process.env.LEGACY_STATUS_SECRET))return c.json({error:'unauthorized'},401);
      return await next();
    }
    // A status credential must never authorize a fixed write-capable service,
    // even if an operator accidentally duplicates a configured secret.
    if(authorized(c.req.header('authorization'),process.env.LEGACY_STATUS_SECRET))return c.json({error:'status_credential_read_only'},403);
    if(recovery) {
      if(!authorized(c.req.header('authorization'),process.env.OPERATOR_SECRET))return c.json({error:'unauthorized'},401);
      return await next();
    }
  }

  if(c.req.path==='/api/legacy/continuity'||c.req.path.startsWith('/api/reconcile/'))return c.json({error:'operator_role_required'},403);

  if(['/api/ordinary-buybacks/process','/api/lp-rewards/process','/api/lp-rewards/status','/api/nft-staking/process','/api/nft-staking/status'].includes(c.req.path)){
    if(!authorized(c.req.header('authorization'),process.env.CRON_SECRET))return c.json({error:'unauthorized'},401);
    await next();return;
  }
  if(c.req.path.startsWith('/api/privacy/')){
    if(!authorized(c.req.header('authorization'),process.env.PRIVACY_SECRET))return c.json({error:'unauthorized'},401);
    if(Number(c.req.header('content-length')??0)>24000)return c.json({error:'request_too_large'},413);
    await next();return;
  }
  const secret=c.req.path==='/api/lab/setup'?process.env.OPERATOR_SECRET:c.req.path.startsWith('/api/lab/')?process.env.LAB_RESEARCH_SECRET:['/api/weather/relay','/api/liquidity/process','/api/nfts/process','/api/nfts/status','/api/predictions/process','/api/predictions/status','/api/predictions/preflight','/api/arbitrage/process','/api/arbitrage/status','/api/arbitrage/preflight','/api/arbitrage/buybacks','/api/arbitrage/buyback-status'].includes(c.req.path)?process.env.CRON_SECRET:c.req.path==='/api/setup'||c.req.path==='/api/wallet/proof'?process.env.OPERATOR_SECRET:c.req.path==='/api/wallet/releases'?process.env.RELEASE_SECRET:c.req.path.startsWith('/api/wallet/')?process.env.WALLET_SECRET:process.env.INFERENCE_SECRET;
  if(!authorized(c.req.header('authorization'),secret))return c.json({error:'unauthorized'},401);
  if(Number(c.req.header('content-length')??0)>(c.req.path==='/api/completion'?4200000:1500000))return c.json({error:'request_too_large'},413);
  await next();
});
installJobsRoutes(app);
installCapitalRoutes(app);
installPartnerGateway(app);
installGithubRoutes(app);
installOciRoutes(app);
installInfrastructureRoutes(app);
installRuntimeGuardian(app);
installProgramRoutes(app);
installPublisherRoutes(app);
installWebsiteAdmin(app);
installSurfacePublisherRoutes(app);
installConfigurationRoutes(app);
installSocialRoutes(app);
installSearchRoutes(app);
app.post('/api/lab/setup',async c=>c.json(await setupResearchPayments()));
app.post('/api/lab/payments',async c=>{
  try{const raw=await c.req.text();if(raw.length>64000)return c.json({error:'request_too_large'},413);return c.json(await researchPayments().prepare(JSON.parse(raw)));}
  catch(error){return c.json({error:/^lab_[a-z_]+$/.test(error.message)?error.message:'lab_payment_unavailable'},409);}
});
app.get('/api/lab/payments/:id',async c=>c.json(await researchPayments().status(c.req.param('id'))));
for(const action of ['submit','reconcile'])app.post('/api/lab/payments/:id/'+action,async c=>{
  try{return c.json(await researchPayments()[action](c.req.param('id')));}
  catch(error){return c.json({error:/^lab_[a-z_]+$/.test(error.message)?error.message:'lab_payment_unavailable'},409);}
});
app.get('/api/privacy/configuration',c=>c.json(privacyConfiguration()));
for(const action of ['fees','quote','submit','status'])app.post('/api/privacy/'+action,async c=>{
  try{
    const raw=await c.req.text();if(raw.length>24000)return c.json({error:'request_too_large'},413);
    const input=JSON.parse(raw),relay=privacyRelay();
    return c.json(await relay[action](action==='status'?input.id:input));
  }catch(error){
    const exposed=new Set(['invalid_request','invalid_recipient','invalid_quote','quote_expired','privacy_not_active','gas_too_high',
      'amount_too_small_for_gas','recovery_required','relay_funds_unavailable','relay_budget_unavailable','relay_busy']);
    return c.json({error:exposed.has(error.message)?error.message:'relay_unavailable',
      ...(['gas_too_high','amount_too_small_for_gas','relay_funds_unavailable'].includes(error.message)&&error.feeEstimate?{feeEstimate:error.feeEstimate}:{})},503);
  }
});
app.post('/api/setup',async c=>{
  await sql()`CREATE TABLE IF NOT EXISTS claus_inference (id text PRIMARY KEY,request_hash text NOT NULL,status text NOT NULL,response jsonb,payment_payload jsonb,created_at timestamptz NOT NULL DEFAULT now())`;
  await sql()`ALTER TABLE claus_inference ADD COLUMN IF NOT EXISTS outcome jsonb`;
  await sql()`ALTER TABLE claus_inference ADD COLUMN IF NOT EXISTS image_day date`;
  await sql()`ALTER TABLE claus_inference ADD COLUMN IF NOT EXISTS image_slot integer`;
  await sql()`CREATE UNIQUE INDEX IF NOT EXISTS claus_image_daily_slot ON claus_inference(image_day,image_slot)`;
  await initializeWallet();
  return c.json({ready:true});
});
app.post('/api/wallet/read',async c=>c.json(await productionWallet().read(await c.req.json())));
app.get('/api/weather/relay',async c=>c.json(await relayWeather()));
app.get('/api/liquidity/process',async c=>c.json(await processLiquidity()));
app.get('/api/ordinary-buybacks/process',async c=>c.json(await processOrdinaryBuybacks()));
app.get('/api/nfts/status',c=>c.json(nftMaintenanceConfiguration()));
app.get('/api/nfts/process',async c=>c.json(await processNfts()));
app.get('/api/nft-staking/status',c=>c.json(nftStakingConfiguration()));
app.get('/api/nft-staking/process',async c=>c.json(await processNftStaking()));
app.get('/api/lp-rewards/status',c=>c.json(lpRewardsConfiguration()));
app.get('/api/lp-rewards/process',async c=>c.json(await processLpRewards()));
app.get('/api/predictions/status',c=>c.json(predictionMaintenanceConfiguration()));
app.get('/api/predictions/preflight',async c=>c.json(await predictionDeploymentPreflight()));
app.get('/api/predictions/process',async c=>c.json(await processPredictions()));
app.get('/api/arbitrage/buybacks',async c=>c.json(await processBuybacks()));
app.get('/api/arbitrage/buyback-status',c=>c.json(buybackConfiguration()));
app.get('/api/arbitrage/preflight',async c=>c.json(await arbitragePreflight()));
app.get('/api/arbitrage/status',c=>c.json(arbitrageConfiguration()));
app.get('/api/arbitrage/process',async c=>c.json(await processArbitrage()));
app.post('/api/wallet/prepare',async c=>c.json(await productionWallet().prepare(c.req.header('idempotency-key'),await c.req.json())));
app.post('/api/wallet/execute',async c=>c.json(await productionWallet().execute((await c.req.json()).id)));
app.post('/api/wallet/replace',async c=>c.json(await productionWallet().replace((await c.req.json()).id,c.req.header('idempotency-key'))));
app.post('/api/wallet/sign',async c=>c.json(await productionWallet().signature(c.req.header('idempotency-key'),await c.req.json())));
app.get('/api/wallet/actions/:id',async c=>{const result=await productionWallet().status(c.req.param('id'));return result?c.json(result):c.json({error:'not_found'},404);});
app.post('/api/wallet/proof',async c=>c.json(await productionWallet().proof(c.req.header('idempotency-key'))));
app.get('/api/wallet/releases/:id',async c=>{const v=await walletRepository().release(stableId(c.req.param('id')));return v?c.json({passed:v.passed,releaseId:c.req.param('id'),sourceHash:v.sourceHash,projectId:v.projectId,projectVersion:v.projectVersion,snapshotId:v.snapshotId,forkBlock:v.forkBlock,forkBlockHash:v.forkBlockHash,tests:v.tests,artifacts:v.artifacts.map(a=>({path:a.path,sha256:a.sha256,abi:a.abi,bytecodeBytes:(a.bytecode.length-2)/2}))}):c.json({error:'not_found'},404);});
app.post('/api/wallet/releases',async c=>{
  const id=stableId(c.req.header('idempotency-key')),release=await c.req.json();
  if(!release.passed||!Array.isArray(release.artifacts)||!release.artifacts.length||!release.sourceHash||!release.tests?.unit?.passed||!release.tests?.fork?.passed) return c.json({error:'release_evidence_incomplete'},400);
  return c.json(await walletRepository().attest(id,release));
});
app.get('/api/legacy/continuity',async c=>c.json(await readContinuity(sql())));
app.post('/api/reconcile/:id',async c=>{
  const db=sql(),id=c.req.param('id');
  const rows=await db`SELECT status,payment_payload,outcome,created_at FROM claus_inference WHERE id=${id}`;
  if(!rows.length)return c.json({error:'not_found'},404);
  const row=rows[0];
  if(!['completed','failed'].includes(row.status)&&!requestMayBeActive(row)) {
    let result=null;
    if(row.payment_payload) {
      try {result=await paymentOutcome(row.payment_payload,row.outcome??{});}catch { /* Keep uncertain holds. */ }
    } else if(row.status==='reserved'&&Date.now()-Date.parse(row.created_at)>=800000)
      result={failure:'authorization_not_created',payment:'not_signed'};
    if(result)await db`UPDATE claus_inference SET status='failed',outcome=${JSON.stringify(result)}::jsonb WHERE id=${id} AND status=${row.status}`;
  }
  return c.json((await db`SELECT status,response,outcome FROM claus_inference WHERE id=${id}`)[0]);
});
app.get('/api/requests/:id',async c=>{
  const db=sql(),id=c.req.param('id');
  // Frozen legacy observer: one projection-only SELECT, no authorization
  // material, reconciliation RPC, UPDATE or replay.
  if(process.env.SERVICE_ROLE==='operator') {
    const rows=await db`SELECT status,response,outcome FROM claus_inference WHERE id=${id}`;
    return rows.length?c.json({status:rows[0].status,response:rows[0].response,outcome:rows[0].outcome}):c.json({error:'not_found'},404);
  }
  const rows=await db`SELECT status,response,payment_payload,outcome,created_at FROM claus_inference WHERE id=${id}`;
  if(!rows.length)return c.json({error:'not_found'},404);
  const row=rows[0];
  if(!['completed','failed'].includes(row.status)&&!requestMayBeActive(row)) {
    let outcome=null;
    if(row.payment_payload) {
      try {outcome=await paymentOutcome(row.payment_payload,row.outcome??{});} catch { /* RPC outage preserves the reservation. */ }
    } else if(row.status==='reserved'&&Date.now()-Date.parse(row.created_at)>=800000) {
      outcome={failure:'authorization_not_created',payment:'not_signed'};
    }
    if(outcome) {
      await db`UPDATE claus_inference SET status='failed',outcome=${JSON.stringify(outcome)}::jsonb WHERE id=${id} AND status=${row.status}`;
    }
  }
  return c.json((await db`SELECT status,response,outcome FROM claus_inference WHERE id=${id}`)[0]);
});
async function completion(c) {
  const isImage=c.req.path==='/api/images',endpoint=isImage?imageEndpoint:inferenceEndpoint;
  const timing=completionTiming(isImage,c.req.header('x-inference-purpose'));
  const id=c.req.header('idempotency-key');
  if(!id||!/^[a-zA-Z0-9:_-]{1,160}$/.test(id))return c.json({error:'stable_request_id_required'},400);
  if(!process.env.SIGNER_PRIVATE_KEY)return c.json({error:'signer_not_configured'},503);
  const raw=await c.req.text();
  if(Buffer.byteLength(raw)>(isImage?10000:4200000))return c.json({error:'request_too_large'},413);
  let request;
  try {request=JSON.parse(raw);if(isImage)request=await imageRequest(request);else validateRequest(request);}catch {return c.json({error:'request_refused',payment:'not_signed'},400);}
  const body=JSON.stringify(request);
  let budget;
  try {budget=requestBudget(body,isImage?imageQuoteLimit:BigInt(process.env.MAX_INFERENCE_QUOTE_MICRO_USDC??'1000000'),c.req.header('x-max-quote-micro-usdc'));}
  catch {return c.json({error:'invalid_request_budget',payment:'not_signed'},400);}
  const {hash,maximum}=budget;
  const db=sql();
  const existing=await db`SELECT request_hash,status,response FROM claus_inference WHERE id=${id}`;
  if(existing.length) {
    if(existing[0].request_hash!==hash)return c.json({error:'request_id_conflict'},409);
    return existing[0].status==='completed'?c.json(existing[0].response):c.json({error:'payment_requires_reconciliation'},409);
  }
  const reserved=await reserveInference(db,{id,hash,maximum,isImage,activeMs:timing.activeMs,legacy:c.get('legacyContinuity')});
  if(!reserved.length)return c.json({error:'request_already_reserved'},409);
  let authorizationCreated=false;
  const started=Date.now();
  let outcome={failure:'request_interrupted'};
  try {
    const account=privateKeyToAccount(process.env.SIGNER_PRIVATE_KEY);
    if(account.address.toLowerCase()!==address.toLowerCase())throw new Error('wallet_mismatch');
    const schemes=inferencePaymentSchemes(isImage);
    const quoted=await quoteWithinBudget(request,{maximum,schemes,endpoint,allowSmallerOutput:!isImage,fetchQuote:async candidate=>{
      const challengeResponse=await fetch(endpoint,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify(candidate),signal:AbortSignal.timeout(20000)});
      if(challengeResponse.status!==402) {
        outcome={failure:'quote_rejected',httpStatus:challengeResponse.status};
        throw new Error('quote_rejected');
      }
      outcome={failure:'payment_quote_rejected',maximumMicroUsdc:String(maximum),...(!isImage?{requestedMaxOutputTokens:request.max_output_tokens,effectiveMaxOutputTokens:candidate.max_output_tokens}:{})};
      return challengeResponse.json();
    }});
    const {challenge}=quoted;
    let {requirement}=quoted;
    const paidBody=JSON.stringify(quoted.request);
    outcome={failure:'inference_funding_check_unavailable'};
    let funding=await inferenceFunding(requirement),paymentFallback;
    if(requirement.scheme==='upto'&&!funding.allowanceSufficient) {
      if(!schemes.includes('exact')) {
        outcome={failure:'permit2_allowance_required',requiredMicroUsdc:requirement.amount};
        throw new Error('permit2_allowance_required');
      }
      // Legacy opt-in fallback only. The separate relay requires upto_only.
      requirement=validateChallenge(challenge,maximum,['exact'],endpoint);
      paymentFallback='permit2_allowance_required';
      funding={...await inferenceFunding(requirement),permit2AllowanceMicroUsdc:funding.permit2AllowanceMicroUsdc};
    }
    if(!funding.sufficient) {
      outcome={failure:'inference_funding_required',availableMicroUsdc:funding.availableMicroUsdc,requiredMicroUsdc:funding.requiredMicroUsdc};
      throw new Error('inference_funding_required');
    }
    // Fence expired/reconciled reservations before creating a signature. A
    // crashed authorizing row is never treated as a provably unsigned row.
    const claimed=await db`UPDATE claus_inference SET status='authorizing' WHERE id=${id} AND status='reserved'
      AND (outcome->>'activeUntil')::timestamptz>now() RETURNING id,
      (extract(epoch FROM ((outcome->>'activeUntil')::timestamptz-now()))*1000)::integer AS remaining_ms`;
    if(!claimed.length) {outcome={failure:'reservation_fenced'};throw new Error('reservation_fenced');}
    // Quote negotiation and funding checks use the same DB lease. They must
    // not leave a paid request running after reconciliation may fence it.
    const providerMs=Math.min(timing.providerMs,Number(claimed[0].remaining_ms)-30000);
    if(!Number.isFinite(providerMs)||providerMs<=0) {outcome={failure:'request_deadline_reached'};throw new Error('request_deadline_reached');}
    // No approval extensions: only a per-request signature is created here.
    const signed=await new (requirement.scheme==='upto'?UptoEvmScheme:ExactEvmScheme)(account).createPaymentPayload(2,requirement);
    authorizationCreated=true;
    const payment={...signed,accepted:requirement,resource:challenge.resource};
    // Persist the exact authorization before the only paid network attempt.
    const persisted=await db`UPDATE claus_inference SET status='signed',payment_payload=${JSON.stringify(payment)}::jsonb
      WHERE id=${id} AND status='authorizing' RETURNING id`;
    if(!persisted.length)throw new Error('authorization_fenced');
    // Funding has succeeded. A timeout from here belongs to provider delivery,
    // not the earlier balance/allowance check; the signed payment stays reserved.
    outcome={failure:'provider_response_not_received'};
    const response=await inferenceFetch(endpoint,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','PAYMENT-SIGNATURE':Buffer.from(JSON.stringify(payment)).toString('base64')},body:paidBody,signal:AbortSignal.timeout(Math.floor(providerMs))});
    // Keep outcome metadata even when an upstream returns HTML or invalid JSON.
    outcome={failure:'provider_response_unreadable',providerResponseReceived:true,httpStatus:response.status};
    const result=await response.json();
    if(!response.ok) {
      outcome=providerFailure(response,result,payment);
      throw new Error('paid_result_uncertain');
    }
    outcome={failure:'provider_response_invalid',providerResponseReceived:true,httpStatus:response.status,...responseShape(result)};
    const {receipt,telemetry}=responseMetadata(response,started);
    const safe={...(isImage?normalizeImage(result):normalizeResponse(result,request.model)),receipt,telemetry:{...telemetry,paymentScheme:requirement.scheme,authorizedMicroUsdc:requirement.amount,...(!isImage?{requestedMaxOutputTokens:request.max_output_tokens,effectiveMaxOutputTokens:quoted.request.max_output_tokens,requestedInputItems:request.input.length,effectiveInputItems:quoted.request.input.length}:{}),...(paymentFallback?{paymentFallback}:{}),...(funding.permit2AllowanceMicroUsdc!==undefined?{permit2AllowanceMicroUsdc:funding.permit2AllowanceMicroUsdc}:{})}};
    const completed=await db`UPDATE claus_inference SET status='completed',response=${JSON.stringify(safe)}::jsonb
      WHERE id=${id} AND status='signed' RETURNING id`;
    if(!completed.length)throw new Error('result_requires_reconciliation');
    await afterInference(db,id).catch(()=>{});
    return c.json(safe);
  } catch(error) {
    if(outcome.failure==='inference_funding_check_unavailable'&&['balance','allowance'].includes(error?.fundingCheck?.stage)
      &&error.fundingCheck.attempts===2&&['rate_limited','timeout','transport','unavailable'].includes(error.fundingCheck.reason))
      outcome={...outcome,fundingCheck:{stage:error.fundingCheck.stage,attempts:2,reason:error.fundingCheck.reason}};
    if(['quote_refused','wrong_payment_resource','invalid_recipient','wrong_signing_domain','invalid_payment_lifetime'].includes(error?.message))outcome={...outcome,rejection:error.message};
    if(['invalid_model_response','invalid_function_call'].includes(error?.message))outcome={...outcome,providerCode:error.message};
    if(['TimeoutError','AbortError','SyntaxError','TypeError'].includes(error?.name))outcome={...outcome,errorType:error.name};
    if(['UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_CONNECT_TIMEOUT','ECONNRESET'].includes(error?.cause?.code))outcome={...outcome,transportCode:error.cause.code};
    if(!authorizationCreated)outcome={...outcome,payment:'not_signed'};
    await db`UPDATE claus_inference SET status=${authorizationCreated?'uncertain':'failed'},outcome=${JSON.stringify(outcome)}::jsonb
      WHERE id=${id} AND status IN ('reserved','authorizing','signed')`;
    await afterInference(db,id).catch(()=>{});
    return c.json({error:'payment_requires_reconciliation',id},502);
  }
}
app.post('/api/completion',completion);
app.post('/api/images',completion);
app.onError((error,c)=>{const code=/^(wallet_[a-z_]+|weather_[a-z_]+|liquidity_[a-z_]+|prediction_[a-z_]+|arbitrage_[a-z_]+|buyback_[a-z_]+|invalid_[a-z_]+|stable_request_id_required|deployment_requires_built_artifact|verified_release_required|deployable_artifact_required|release_id_conflict|unsupported_wallet_chain|signed_nonce_mismatch)$/.test(error.message)?error.message:'service_operation_failed';return c.json({error:code},code==='wallet_disabled_by_owner_policy'?403:503);});
return app;
}
export default createSignerApp();
