import {isDealReview,validateNativeDealReview,reviewCapability} from './network-deal-review.js';
import {configuration,sql} from './store.js';
import {networkHash,networkReviewRequest,parseNetworkDecision,validateNetworkReview} from './network-review-schema.js';
import {inferenceFetch} from './inference-transport.js';

type Query=ReturnType<typeof sql>;
const visible=(row:any)=>({id:row.id,state:row.state,inputHash:row.input_hash,proposalHash:row.input.proposalHash,
 configurationRevision:row.configuration_revision,configurationHash:row.configuration_hash,
 model:row.request.model,result:row.result??null,retryAt:row.available_at});
const validId=(id:string)=>{if(!/^nr_[a-f0-9]{64}$/.test(id))throw Error('network_review_invalid_id');return id;};
async function rowFor(id:string,db:Query=sql()) {
 const row=(await db`SELECT * FROM claus_network_reviews WHERE id=${validId(id)}`)[0];
 if(!row)throw Error('network_review_not_found');return row;
}
async function json(response:Response) {
 if(!response.body)throw Error('network_review_empty_response');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1048576)throw Error('network_review_response_limit');chunks.push(value);}}
 catch(error){await reader.cancel().catch(()=>{});throw error;}
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function relay(){
 // This role inherits the already configured inference payer, never a URL,
 // account or credential supplied by a project.
 const origin=process.env.INFERENCE_URL,secret=process.env.INFERENCE_SECRET;
 if(origin!=='https://claus-ecosystem-payments.vercel.app'||!secret)throw Error('network_review_relay_unavailable');
 return {origin,headers:{authorization:'Bearer '+secret,'content-type':'application/json'}};
}
export async function setupNetworkReviews(db:Query=sql()) {
 await db`CREATE TABLE IF NOT EXISTS claus_network_review_revocations (id text PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now())`;
 await db`CREATE TABLE IF NOT EXISTS claus_network_reviews (
  id text PRIMARY KEY,input_hash text NOT NULL,input jsonb NOT NULL,request jsonb NOT NULL,
  configuration_revision integer NOT NULL,configuration_hash text NOT NULL,
  state text NOT NULL CHECK(state IN ('queued','running','uncertain','completed','failed','blocked')),
  result jsonb,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz)`;
 // One active decision. An uncertain purchase retains its slot until the
 // payer confirms execution ended; its monetary hold and ID remain intact.
 await db`CREATE UNIQUE INDEX IF NOT EXISTS claus_network_review_active ON claus_network_reviews ((true)) WHERE state IN ('queued','running','uncertain')`;
}
async function expireQueued(db:Query) {
 await db`UPDATE claus_network_reviews SET state='blocked',result='{"error":"authority_or_window_closed"}'::jsonb,updated_at=now()
  WHERE state='queued' AND ((input->'proposal'->>'expiresAt')::bigint<=extract(epoch FROM now())+3600
   OR EXISTS(SELECT 1 FROM claus_network_review_revocations r WHERE r.id=claus_network_reviews.id)
   OR (SELECT (content->'policy'->'capabilities'->>(CASE WHEN claus_network_reviews.input->>'profile'='claus-deal-resolution-v1' THEN 'networkDealReview' ELSE 'networkReview' END))::boolean AND (content->'settings'->>'enabled')::boolean FROM claus_config ORDER BY revision DESC LIMIT 1) IS NOT TRUE)`;
}
// Operator-configured recovery applies on one UTC day only. Failed attempts
// remain counted, the active-case lock and the payer ceiling stay unchanged.
export function networkReviewDailyLimit(now=Date.now(),env=process.env,projectId?:string) {
 const n=Number(env.NETWORK_REVIEW_RECOVERY_LIMIT),projects=(env.NETWORK_REVIEW_RECOVERY_PROJECTS??'').split(',');
 if(projects.length>2||!projects.every(p=>/^prj_[a-f0-9-]{36}$/.test(p))||!projectId||!projects.includes(projectId))return 8;
 return /^(8|9|1[0-6])$/.test(env.NETWORK_REVIEW_RECOVERY_LIMIT??'')&&env.NETWORK_REVIEW_RECOVERY_DAY===new Date(now).toISOString().slice(0,10)&&
  Number.isInteger(n)&&n>=8&&n<=16?n:8;
}
export async function submitNetworkReview(input:any,db:Query=sql(),readConfig=configuration) {
 if(isDealReview(input))await validateNativeDealReview(input);else validateNetworkReview(input);
 await expireQueued(db);
 const config=await readConfig(),request=networkReviewRequest(input,config);
 if(input.proposal.expiresAt<=Math.floor(Date.now()/1000)+3600)throw Error('network_review_proposal_expires');
 const inputHash=networkHash(input),id='nr_'+inputHash.slice(7);
 if((await db`SELECT id FROM claus_network_review_revocations WHERE id=${id}`).length)throw Error('network_review_revoked');
 const existing=(await db`SELECT * FROM claus_network_reviews WHERE id=${id}`)[0];
 if(existing)return visible(existing);
 try{
  const rows=await db`INSERT INTO claus_network_reviews(id,input_hash,input,request,configuration_revision,configuration_hash,state)
    SELECT ${id},${inputHash},${JSON.stringify(input)}::jsonb,${JSON.stringify(request)}::jsonb,${config.revision},${config.hash},'queued'
    WHERE (SELECT count(*) FROM claus_network_reviews WHERE created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')<${networkReviewDailyLimit(Date.now(),process.env,input.projectId)}
     AND (NOT ${isDealReview(input)} OR (SELECT count(*) FROM claus_network_reviews WHERE input->>'profile'='claus-deal-resolution-v1')<8)
     AND NOT EXISTS(SELECT 1 FROM claus_network_review_revocations WHERE id=${id})
    ON CONFLICT(id) DO NOTHING RETURNING *`;
  if(rows.length)return visible(rows[0]);
  const concurrent=(await db`SELECT * FROM claus_network_reviews WHERE id=${id}`)[0];
  if(concurrent)return visible(concurrent);
 }catch(error:any){if(error?.code!=='23505')throw error;}
 throw Error('network_review_capacity');
}
async function finish(row:any,result:any,db:Query=sql()) {
 let verdict;
 try{verdict=parseNetworkDecision(result,row.request.model);}
 catch(error){
  await db`UPDATE claus_network_reviews SET state='failed',result=${JSON.stringify({error:'incomplete_or_invalid_model_result',inference:result})}::jsonb,updated_at=now()
    WHERE id=${row.id} AND state IN ('running','uncertain')`;
  return;
 }
 const decision={...verdict,inputHash:row.input_hash,proposalHash:row.input.proposalHash,
   reviewArtifactHash:row.input.review.artifactHash,configurationRevision:row.configuration_revision,
   configurationHash:row.configuration_hash,model:row.request.model,inferenceReceipt:result.receipt??null,
   completedAt:new Date().toISOString()};
 const saved={...decision,decisionHash:networkHash(decision)};
 await db`UPDATE claus_network_reviews SET state='completed',result=${JSON.stringify(saved)}::jsonb,updated_at=now()
   WHERE id=${row.id} AND state IN ('running','uncertain')`;
}
export async function runNetworkReview(id:string,ports:{db?:Query;readConfig?:typeof configuration;fetcher?:typeof fetch}={}) {
 const db=ports.db??sql(),fetcher=ports.fetcher??inferenceFetch,readConfig=ports.readConfig??configuration;
 await expireQueued(db);const row=await rowFor(id,db);
 if(row.state!=='queued'||Date.parse(row.available_at)>Date.now())return visible(row);
 const config=await readConfig();
 if(!config.settings.enabled||config.policy.capabilities[reviewCapability(row.input)]!==true||row.input.proposal.expiresAt<=Date.now()/1000+3600){
  await db`UPDATE claus_network_reviews SET state='blocked',result='{"error":"authority_or_window_closed"}'::jsonb,updated_at=now() WHERE id=${id} AND state='queued'`;
  return visible(await rowFor(id,db));
 }
 const {origin,headers}=relay(),effectId='network-review:'+id;
 // Capacity checks are read-only; a fresh paid intent is committed only when
 // the existing payer admits this exact request ceiling.
 let admitted=false;
 try{const response=await fetcher(origin+'/api/admission/'+encodeURIComponent(effectId)+'?maximumMicroUsdc=2000000',{headers,redirect:'error',signal:AbortSignal.timeout(15000)});
  if(response.ok){const status=await json(response);admitted=status.id===effectId&&status.ready===true&&status.maximumMicroUsdc==='2000000'&&status.rail==='surplus_credit';}}
 catch{}
 if(!admitted){await db`UPDATE claus_network_reviews SET available_at=now()+interval '60 seconds' WHERE id=${id} AND state='queued'`;return visible(await rowFor(id,db));}
 const claimed=await db`UPDATE claus_network_reviews SET state='running',started_at=now(),updated_at=now() WHERE id=${id} AND state='queued'
  AND NOT EXISTS(SELECT 1 FROM claus_network_review_revocations WHERE id=${id})
  AND (SELECT (content->'policy'->'capabilities'->>${reviewCapability(row.input)})::boolean AND (content->'settings'->>'enabled')::boolean FROM claus_config ORDER BY revision DESC LIMIT 1) IS TRUE RETURNING *`;
 if(!claimed.length)return visible(await rowFor(id,db));
 try{
  // Full compiler evidence needs the existing finite research transport. This
  // changes only delivery time, never the saved request, price cap or retry ID.
  const response=await fetcher(origin+'/api/completion',{method:'POST',headers:{...headers,'Idempotency-Key':effectId,'X-Max-Quote-Micro-USDC':'2000000','X-Inference-Purpose':'research'},
   body:JSON.stringify(row.request),redirect:'error',signal:AbortSignal.timeout(650000)});
  const body=await json(response);
  // Only the trusted payer's explicit pre-reservation deferral can return
  // this same ID to the queue. Lost acknowledgements are never retried.
  if(body?.id===effectId&&body?.admission==='deferred'&&body?.payment==='not_signed'&&
    ['credit_busy','credit_capacity_wait','credit_exhausted','credit_unavailable','credit_pilot_wait',
     'credit_profile_unavailable','credit_not_configured','credit_ceiling_mismatch'].includes(body?.error)){
   await db`UPDATE claus_network_reviews SET state='queued',started_at=NULL,available_at=now()+interval '60 seconds',updated_at=now() WHERE id=${id} AND state='running'`;
   return visible(await rowFor(id,db));
  }
  if(!response.ok)throw Error('network_review_inference_uncertain');
  // A streamed relay response commits HTTP 200 before a later failure. That
  // envelope is not a model result; reconcile its original payment ID.
  if(body?.error)throw Error('network_review_inference_uncertain');
  await finish(row,{model:body.model,message:body.choices?.[0]?.message,receipt:body.receipt,telemetry:body.telemetry,
    responseStatus:body.responseStatus,finishReason:body.choices?.[0]?.finish_reason},db);
 }catch{
  await db`UPDATE claus_network_reviews SET state='uncertain',updated_at=now() WHERE id=${id} AND state='running'`;
 }
 return visible(await rowFor(id,db));
}
async function presented(row:any,db:Query){
 if(!isDealReview(row.input))return visible(row);
 const config=await configuration(),revoked=(await db`SELECT id FROM claus_network_review_revocations WHERE id=${row.id}`).length>0;
 return {...visible(row),authorizationActive:!revoked&&config.settings.enabled&&config.policy.capabilities.networkDealReview===true&&row.input.proposal.expiresAt>Date.now()/1000};
}
export async function networkReviewStatus(id:string,ports:{db?:Query;fetcher?:typeof fetch}={}) {
 const db=ports.db??sql(),fetcher=ports.fetcher??fetch;await expireQueued(db);let row=await rowFor(id,db);
 if(!['running','uncertain'].includes(row.state))return presented(row,db);
 // The payer's negative status response permanently fences a missing ID.
 // Do not race that lookup against the original POST's admission. The POST
 // saves normal completion itself; only reconcile after its delivery window.
 const startedAt=Date.parse(row.started_at);
 if(!Number.isFinite(startedAt)||Date.now()-startedAt<=800000)return presented(row,db);
 const {origin,headers}=relay(),effectId='network-review:'+id;
 try{
  const response=await fetcher(origin+'/api/requests/'+encodeURIComponent(effectId),{headers,redirect:'error',signal:AbortSignal.timeout(15000)});
  if(response.ok){const body=await json(response);
   if(body.status==='completed'&&body.response?.model===row.request.model){const b=body.response;
    await finish(row,{model:b.model,message:b.choices?.[0]?.message,receipt:b.receipt,telemetry:b.telemetry,
     responseStatus:b.responseStatus,finishReason:b.choices?.[0]?.finish_reason},db);
   }else if(body.status==='failed'&&['not_signed','not_settled','settled'].includes(body.outcome?.payment)){
    await db`UPDATE claus_network_reviews SET state='failed',result=${JSON.stringify({error:'inference_failed',outcome:body.outcome,accounting:body.accounting??null})}::jsonb,updated_at=now() WHERE id=${id} AND state IN ('running','uncertain')`;
   }else if(body.id===effectId&&body.status==='uncertain'&&body.rail==='surplus_credit'&&body.execution?.active===false&&
     Number.isFinite(Date.parse(body.execution.activeUntil))&&Date.parse(body.execution.activeUntil)<=Date.now()){
    // Delivery ended, not payment reconciliation. Preserve the payer's hold
    // and terminally fail this review; never approve or replay it.
    await db`UPDATE claus_network_reviews SET state='failed',result=${JSON.stringify({error:'inference_delivery_unknown',paymentHoldRetained:true,inferenceId:effectId,outcome:body.outcome??null})}::jsonb,updated_at=now() WHERE id=${id} AND state IN ('running','uncertain')`;
   }
  }else if(response.status===404&&Date.now()-Date.parse(row.started_at)>800000&&(await json(response)).error==='not_found'){
   // The fixed payer fences missing request IDs against subsequent admission.
   await db`UPDATE claus_network_reviews SET state='failed',result='{"error":"inference_not_reserved"}'::jsonb,updated_at=now() WHERE id=${id} AND state IN ('running','uncertain')`;
  }
 }catch{/* The existing reservation and request identity remain unchanged. */}
 row=await rowFor(id,db);return presented(row,db);
}
export async function cancelNetworkReview(id:string,ports:{db?:Query;fetcher?:typeof fetch}={}) {
 validId(id);const db=ports.db??sql();
 // The tombstone also fences an original POST that arrives after cancellation.
 await db`INSERT INTO claus_network_review_revocations(id) VALUES(${id}) ON CONFLICT(id) DO NOTHING`;
 await db`UPDATE claus_network_reviews SET state='blocked',result='{"error":"network_request_revoked"}'::jsonb,updated_at=now() WHERE id=${id} AND state='queued'`;
 if(!(await db`SELECT id FROM claus_network_reviews WHERE id=${id}`).length)return {id,state:'blocked',revoked:true};
 return networkReviewStatus(id,{...ports,db});
}
