import {diagnose} from './diagnosis.js';
const code=v=>typeof v==='string'&&/^[a-z][a-z0-9_:-]{0,150}$/.test(v)?v:null;
const reference=v=>typeof v==='string'&&/^[a-zA-Z0-9:_-]{1,200}$/.test(v)?v:null;
const money=v=>typeof v==='string'&&/^\d{1,20}$/.test(v)?v:null;
const date=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
export async function paymentTrace(db,id,now=Date.now){
 if(!reference(id)||id.length>160)throw Error('payment_trace_id_invalid');
 // Projection-only SELECT. No reconciliation, lease expiry, cash refresh,
 // negative receipt creation, model call or payment mutation occurs here.
 const [row]=await db`SELECT (SELECT absent FROM claus_payment_ids WHERE id=${id}) AS absent,
  COALESCE((SELECT jsonb_agg(r) FROM (
   SELECT 'inference' AS rail,id,status,request_hash,reserved_max::text AS maximum,accounted_cost::text AS accounted,
    created_at::text,NULL::text AS dispatched_at,NULL::text AS provider_request_id,NULL::integer AS http_status,
    NULL::text AS client_request_id,outcome->>'failure' AS failure,outcome->>'payment' AS payment,
    cost_proof->>'kind' AS proof_kind,NULL::text AS provider_reason,NULL::text AS settlement_observation,
    outcome->>'retryAtMs' AS retry_at_ms,outcome->>'retryAt' AS retry_at,
    outcome->'transport'->>'phase' AS transport_phase,outcome->>'errorType' AS error_type,outcome->>'transportCode' AS transport_code
   FROM claus_inference WHERE id=${id}
   UNION ALL
   SELECT 'credit-work',id,status,request_hash,reserved_max::text,accounted_cost::text,created_at::text,dispatched_at::text,provider_request_id,http_status,
    binding->>'clientRequestId',outcome->>'failure',outcome->>'payment',COALESCE(outcome->'settlementProof'->>'kind',outcome->'nonpaymentProof'->>'kind'),
    outcome->'nonpaymentProof'->>'reason',outcome->'settlementObservation'->>'reason',outcome->>'retryAtMs',outcome->>'retryAt',
    outcome->'transport'->>'phase',outcome->>'errorType',outcome->>'transportCode'
   FROM claus_credit_work WHERE id=${id}
   UNION ALL
   SELECT 'credit-legacy',id,status,request_hash,reserved_max::text,accounted_cost::text,created_at::text,dispatched_at::text,provider_request_id,http_status,
    binding->>'clientRequestId',outcome->>'failure',outcome->>'payment',NULL::text,NULL::text,NULL::text,outcome->>'retryAtMs',outcome->>'retryAt',
    outcome->'transport'->>'phase',outcome->>'errorType',outcome->>'transportCode'
   FROM claus_credit_requests WHERE id=${id}
  ) r),'[]'::jsonb) AS records`;
 const records=(row?.records??[]).map(r=>{
  const numeric=Number(r.retry_at_ms),retryAt=/^\d{1,16}$/.test(r.retry_at_ms??'')&&Number.isFinite(numeric)&&numeric<=8640000000000000?new Date(numeric).toISOString():date(r.retry_at);
  return {rail:r.rail,id:r.id,status:code(r.status),requestHash:typeof r.request_hash==='string'&&/^(?:sha256:)?[a-f0-9]{64}$/.test(r.request_hash)?r.request_hash:null,createdAt:date(r.created_at),dispatchedAt:date(r.dispatched_at),providerRequestId:reference(r.provider_request_id),clientRequestId:reference(r.client_request_id),diagnosis:diagnose({error:r.provider_reason??r.failure,httpStatus:r.http_status,state:r.status}),settlementObservation:code(r.settlement_observation),paymentLabel:code(r.payment),accounting:{maximumMicroUsd:money(r.maximum),recordedCostMicroUsd:money(r.accounted),unresolvedMaximumMicroUsd:r.accounted===null?money(r.maximum):null,proofKind:code(r.proof_kind),meaning:'Original ledger accounting; this read performs no new financial verification or settlement.'},retryAt,retryAfterSeconds:retryAt?Math.max(0,Math.ceil((Date.parse(retryAt)-now())/1000)):null,transport:{phase:code(r.transport_phase),errorType:['TimeoutError','AbortError','SyntaxError','TypeError'].includes(r.error_type)?r.error_type:null,code:['UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_CONNECT_TIMEOUT','ECONNRESET'].includes(r.transport_code)?r.transport_code:null}};
 });
 return {id,found:records.length>0,records,originalIdFencedAbsent:row?.absent===true,readOnly:true,holdsChanged:false,paymentPayloadsReturned:false,rawResponsesReturned:false,meaning:'Follow original request, provider and client correlation IDs. Missing metadata is unknown, not evidence of nonpayment. Recorded HTTP status establishes the responding boundary only; an internal provider cause is stated only when explicitly recorded.'};
}
