import {createHash} from 'node:crypto';
import {validBuilderBinding} from './builder-transport.js';
const sha=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function interruptedCreditCandidate(row){
 return row?.status==='uncertain'&&row.accounted_cost===null&&!row.active&&row.http_status===200&&
  row.outcome?.failure==='provider_stream_unfinished'&&row.outcome?.responseTransport==='sse'&&
  typeof row.provider_request_id==='string'&&row.outcome?.providerRequestId===row.provider_request_id&&
  row.binding?.endpoint==='https://api.surplusintelligence.ai/v1/chat/completions'&&validBuilderBinding(row.binding?.transport)&&
  typeof row.payload_hash==='string'&&!!row.dispatched_at;
}
export function interruptedCreditProof(row,record,observedAt=new Date().toISOString()){
 if(!interruptedCreditCandidate(row)||record?.request_id!==row.provider_request_id||record.model!==row.binding.transport.model||
  record.settlement_group!=='settled'||!['confirmed','accrued'].includes(record.settlement_status)||record.settlement_type!=='credit'||record.settlement_error!==null||
  !Number.isSafeInteger(record.buyer_cost_micro)||record.buyer_cost_micro<0||BigInt(record.buyer_cost_micro)>BigInt(row.reserved_max)||
  record.fiat_spend_micro!==0||record.usdc_spend_micro!==record.buyer_cost_micro||
  !Number.isFinite(Date.parse(record.confirmed_at))||Date.parse(record.confirmed_at)<Date.parse(row.dispatched_at)||Date.parse(record.confirmed_at)>Date.parse(observedAt)+1000)return null;
 return {kind:'surplus_interrupted_request_settlement',requestId:row.id,providerRequestId:row.provider_request_id,keyId:row.binding.keyId,model:record.model,amount:String(record.buyer_cost_micro),maximum:row.reserved_max,payloadHash:row.payload_hash,settlementType:'credit',settlementGroup:'settled',settlementStatus:record.settlement_status,settlementBasis:record.settlement_basis??null,confirmedAt:record.confirmed_at,observedAt,providerRecordHash:sha(record),executionComplete:false};
}
export function hasInterruptedCreditProof(row){
 const p=row?.outcome?.settlementProof;
 return row?.status==='uncertain'&&!row.active&&row.outcome?.failure==='provider_stream_unfinished'&&
  p?.kind==='surplus_interrupted_request_settlement'&&p.executionComplete===false&&p.requestId===row.id&&p.providerRequestId===row.provider_request_id&&
  p.keyId===row.binding?.keyId&&p.payloadHash===row.payload_hash&&p.model===row.binding?.transport?.model&&p.amount===row.accounted_cost&&p.settlementGroup==='settled';
}
export async function recordInterruptedCreditSettlement(db,row,proof){
 if(!interruptedCreditCandidate(row)||proof?.kind!=='surplus_interrupted_request_settlement'||proof.requestId!==row.id||proof.providerRequestId!==row.provider_request_id||proof.payloadHash!==row.payload_hash||!/^\d{1,16}$/.test(proof.amount)||BigInt(proof.amount)>BigInt(row.reserved_max))return false;
 const rows=await db`WITH locked AS MATERIALIZED(
  SELECT id FROM claus_payment_budget WHERE id=true AND committed>=${row.reserved_max}::bigint FOR UPDATE
 ),reconciled AS(
  UPDATE claus_credit_work SET accounted_cost=${proof.amount}::bigint,
   outcome=COALESCE(outcome,'{}'::jsonb)||jsonb_build_object('payment',CASE WHEN ${proof.amount}::bigint=0 THEN 'not_settled' ELSE 'settled' END,'settlementProof',${JSON.stringify(proof)}::jsonb)
  FROM locked WHERE claus_credit_work.id=${row.id} AND status='uncertain' AND accounted_cost IS NULL AND NOT active
   AND provider_request_id=${row.provider_request_id} AND http_status=200
   AND binding=${JSON.stringify(row.binding)}::jsonb AND payload_hash=${row.payload_hash}
   AND outcome=${JSON.stringify(row.outcome)}::jsonb AND reserved_max=${row.reserved_max}::bigint
  RETURNING reserved_max-accounted_cost AS released
 ) UPDATE claus_payment_budget SET committed=committed-reconciled.released FROM reconciled WHERE id=true RETURNING id`;
 return rows.length===1;
}
