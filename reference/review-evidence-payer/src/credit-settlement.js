import {createHash} from 'node:crypto';
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const amount=value=>Number.isSafeInteger(value)&&value>=0?String(value):null;
export function completedCreditProof(row,record,observedAt=new Date().toISOString()){
 if(row?.status!=='completed'||row.accounted_cost!==null||row.active||row.http_status!==200||
  row.binding?.endpoint!=='https://api.surplusintelligence.ai/v1/responses'||row.binding.transport!==undefined||
  row.outcome?.responseTransport!=='sse'||row.outcome?.responseStatus!=='completed'||
  !row.dispatched_at||!row.provider_request_id||!row.payload_hash||
  row.response?.receipt?.providerRequestId!==row.provider_request_id||row.response?.receipt?.requestId!==row.id||
  row.outcome.providerRequestId!==row.provider_request_id)return null;
 const cost=amount(record?.buyer_cost_micro),saved=amount(row.response?.usage?.buyer_cost_micro);
 if(cost===null||saved!==cost||BigInt(cost)>BigInt(row.reserved_max)||
  record.request_id!==row.provider_request_id||record.model!==row.response?.model||record.model!==row.outcome.returnedModel||
  record.settlement_group!=='settled'||!['confirmed','accrued'].includes(record.settlement_status)||
  record.settlement_type!=='credit'||record.settlement_error!==null||
  record.fiat_spend_micro!==0||amount(record.usdc_spend_micro)!==cost||
  !Number.isFinite(Date.parse(record.confirmed_at))||Date.parse(record.confirmed_at)<Date.parse(row.dispatched_at)||
  Date.parse(record.confirmed_at)>Date.parse(observedAt)+1000)return null;
 return {kind:'surplus_request_log_settlement',requestId:row.id,providerRequestId:row.provider_request_id,keyId:row.binding.keyId,endpoint:row.binding.endpoint,model:record.model,amount:cost,settlementType:'credit',settlementStatus:record.settlement_status,settlementGroup:'settled',confirmedAt:record.confirmed_at,observedAt,providerRecordHash:sha(record),responseHash:sha(row.response)};
}
export function hasSettledCreditProof(row){
 const p=row?.outcome?.settlementProof;
 return row?.status==='completed'&&!row.active&&typeof row.accounted_cost==='string'&&p?.kind==='surplus_request_log_settlement'&&
  p.requestId===row.id&&p.providerRequestId===row.provider_request_id&&p.keyId===row.binding?.keyId&&p.amount===row.accounted_cost&&p.settlementGroup==='settled'&&p.responseHash===sha(row.response);
}
export async function recordCreditSettlement(db,row,proof){
 if(proof?.kind!=='surplus_request_log_settlement'||proof.requestId!==row.id||proof.providerRequestId!==row.provider_request_id||proof.responseHash!==sha(row.response)||!/^\d{1,16}$/.test(proof.amount)||BigInt(proof.amount)>BigInt(row.reserved_max))return false;
 const rows=await db`WITH locked AS MATERIALIZED(
  SELECT id FROM claus_payment_budget WHERE id=true AND committed>=${row.reserved_max}::bigint FOR UPDATE
 ),reconciled AS(
  UPDATE claus_credit_work SET accounted_cost=${proof.amount}::bigint,
   outcome=COALESCE(outcome,'{}'::jsonb)||jsonb_build_object('payment',CASE WHEN ${proof.amount}::bigint=0 THEN 'not_settled' ELSE 'settled' END,'settlementProof',${JSON.stringify(proof)}::jsonb)
  FROM locked WHERE claus_credit_work.id=${row.id} AND status='completed' AND accounted_cost IS NULL AND NOT active
   AND provider_request_id=${row.provider_request_id} AND http_status=200
   AND binding=${JSON.stringify(row.binding)}::jsonb AND payload_hash=${row.payload_hash}
   AND response=${JSON.stringify(row.response)}::jsonb AND reserved_max=${row.reserved_max}::bigint
  RETURNING reserved_max-accounted_cost AS released
 ) UPDATE claus_payment_budget SET committed=committed-reconciled.released FROM reconciled WHERE id=true RETURNING id`;
 return rows.length===1;
}
