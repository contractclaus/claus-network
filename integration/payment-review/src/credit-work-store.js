// Independent request-risk reservations, not additional deposits. The original
// prepaid allocation and every original request stay immutable. A fresh call
// reserves its maximum AGAIN against the operator-approved lifetime ceiling.
// This deliberately overcounts shared prepaid cash while old charges are unknown.
import {creditSnapshot as legacySnapshot} from './credit-store.js';
import {validBuilderBinding} from './builder-transport.js';
const validId=x=>typeof x==='string'&&/^[a-zA-Z0-9:_-]{1,160}$/.test(x);
const amount=x=>typeof x==='string'&&/^\d{1,18}$/.test(x)?BigInt(x):null;
export const creditWorkDDL=`
 CREATE TABLE IF NOT EXISTS claus_credit_work_control(id boolean PRIMARY KEY DEFAULT true CHECK(id),frozen boolean NOT NULL DEFAULT false);
 INSERT INTO claus_credit_work_control(id) VALUES(true) ON CONFLICT DO NOTHING;
 CREATE TABLE IF NOT EXISTS claus_credit_work(
  id text PRIMARY KEY,request_hash text NOT NULL,reserved_max bigint NOT NULL CHECK(reserved_max BETWEEN 1 AND 2000000),
  status text NOT NULL CHECK(status IN ('reserved','submitting','completed','failed','uncertain')),
  response jsonb,outcome jsonb,binding jsonb NOT NULL,payload_hash text,dispatched_at timestamptz,
  provider_request_id text,http_status integer,accounted_cost bigint CHECK(accounted_cost BETWEEN 0 AND reserved_max),
  active boolean NOT NULL DEFAULT true,active_until timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(accounted_cost IS NULL OR status IN ('completed','failed','uncertain')),
  CHECK(NOT active OR status IN ('reserved','submitting','uncertain'))
 );
 CREATE UNIQUE INDEX IF NOT EXISTS claus_credit_work_one_active ON claus_credit_work((true)) WHERE active;
 CREATE UNIQUE INDEX IF NOT EXISTS claus_credit_work_provider ON claus_credit_work(provider_request_id) WHERE provider_request_id IS NOT NULL;
`;
export async function creditSnapshot(db){
 const pool=await legacySnapshot(db);if(!pool)return null;
 const [control]=await db`SELECT frozen FROM claus_credit_work_control WHERE id=true`;
 // Internal adapter shape only: remaining is a request exposure cap, not a
 // funded balance. The provider adapter independently reads the real balance.
 return {...pool,committed:'0',remaining:'2000000',state:pool.state==='funded'&&control?.frozen===false?'funded':'frozen',reservationKind:'independent_request_risk'};
}
export async function readCredit(db,id){
 if(!validId(id))return null;
 const [row]=await db`SELECT id,request_hash,reserved_max::text,status,response,outcome,binding,payload_hash,
 dispatched_at::text,provider_request_id,http_status,accounted_cost::text,active,active_until::text,created_at::text
 FROM claus_credit_work WHERE id=${id}`;return row??null;
}
// A crashed unsigned reservation can be fenced before dispatch. An ambiguous
// submitted request loses only its execution slot, never its monetary hold.
export async function expireCredit(db){
 await db`WITH locked AS MATERIALIZED(SELECT id FROM claus_payment_budget WHERE id=true FOR UPDATE), expired AS(
  UPDATE claus_credit_work SET active=false,status=CASE WHEN status='reserved' THEN 'failed' ELSE 'uncertain' END,
   accounted_cost=CASE WHEN status='reserved' AND dispatched_at IS NULL THEN 0 ELSE accounted_cost END,
   outcome=CASE WHEN status='reserved' AND dispatched_at IS NULL THEN jsonb_build_object('rail','surplus_credit','payment','not_signed','failure','reservation_expired_unsigned') ELSE outcome END
  FROM locked WHERE active AND active_until<=now() AND status IN ('reserved','submitting','uncertain')
  RETURNING CASE WHEN accounted_cost=0 AND dispatched_at IS NULL THEN reserved_max ELSE 0 END AS released
 ) UPDATE claus_payment_budget SET committed=committed-(SELECT COALESCE(SUM(released),0) FROM expired) WHERE id=true`;
}
export async function reserveCredit(db,{id,hash,maximum,activeMs,binding}={}){
 const value=amount(String(maximum));
 if(!validId(id)||typeof hash!=='string'||!hash.length||hash.length>128||hash.includes('\0')||value===null||value<1n||value>2000000n||!Number.isSafeInteger(activeMs)||activeMs<1||activeMs>800000)throw Error('invalid_credit_work_reservation');
 if(!/^0x[a-f0-9]{40}$/i.test(binding?.address??'')||!validId(binding?.keyId)||!/^0x[a-f0-9]{64}$/i.test(binding?.transaction??''))throw Error('invalid_credit_work_binding');
 if(binding.transport!==undefined&&!validBuilderBinding(binding.transport))throw Error('invalid_credit_work_transport');
 await expireCredit(db);
 // The unique execution slot and unique cross-rail ID make concurrent stale
 // admission snapshots roll back the entire lifetime-budget increment.
 return db`WITH admitted AS(
  UPDATE claus_payment_budget SET committed=committed+${String(value)}::bigint
  WHERE id=true AND ceiling IN (100000000,500000000) AND committed BETWEEN 0 AND ceiling-${String(value)}::bigint
   AND EXISTS(SELECT 1 FROM claus_credit_work_control WHERE id=true AND NOT frozen)
   AND EXISTS(SELECT 1 FROM claus_credit_pool WHERE id=true AND state='funded' AND allocated=2000000
    AND deposit_address=${binding.address} AND key_id=${binding.keyId} AND deposit_tx=${binding.transaction})
   AND NOT EXISTS(SELECT 1 FROM claus_credit_work WHERE active)
  RETURNING id
 ),claimed AS(INSERT INTO claus_payment_ids(id,absent) SELECT ${id},false FROM admitted RETURNING id)
 INSERT INTO claus_credit_work(id,request_hash,reserved_max,status,active_until,binding)
 SELECT ${id},${hash},${String(value)}::bigint,'reserved',now()+${activeMs}::integer*interval '1 millisecond',
 jsonb_build_object('reservationKind','independent_request_risk','depositAddress',p.deposit_address,'keyId',p.key_id,'depositTransaction',p.deposit_tx,'endpoint',${binding.transport?.endpoint??'https://api.surplusintelligence.ai/v1/responses'}::text) || ${JSON.stringify(binding.transport?{transport:binding.transport}:{})}::jsonb
 FROM claimed CROSS JOIN claus_credit_pool p WHERE p.id=true RETURNING claus_credit_work.id`;
}
export async function startCredit(db,id,payloadHash,clientRequestId=null){
 if(!validId(id)||!/^([a-f0-9]{64})$/.test(payloadHash??''))return false;
 if(clientRequestId!==null&&!/^claus-[a-f0-9]{64}$/.test(clientRequestId))return false;
 const rows=await db`UPDATE claus_credit_work SET status='submitting',payload_hash=${payloadHash},dispatched_at=clock_timestamp(),
 binding=binding || ${JSON.stringify(clientRequestId===null?{}:{clientRequestId})}::jsonb
 WHERE id=${id} AND active AND status='reserved' AND active_until>clock_timestamp()
 AND EXISTS(SELECT 1 FROM claus_credit_work_control WHERE id=true AND NOT frozen)
 AND EXISTS(SELECT 1 FROM claus_credit_pool WHERE id=true AND state='funded'
  AND deposit_address=claus_credit_work.binding->>'depositAddress' AND key_id=claus_credit_work.binding->>'keyId'
  AND deposit_tx=claus_credit_work.binding->>'depositTransaction') RETURNING id`;return rows.length===1;
}
export async function recordCreditHeaders(db,id,{requestId,httpStatus}={}){
 if(!validId(id)||(requestId!==null&&!validId(requestId))||!Number.isInteger(httpStatus)||httpStatus<100||httpStatus>599)return false;
 const rows=await db`UPDATE claus_credit_work SET provider_request_id=COALESCE(provider_request_id,${requestId}::text),http_status=COALESCE(http_status,${httpStatus}::integer)
 WHERE id=${id} AND status='submitting' AND active AND (provider_request_id IS NULL OR provider_request_id=${requestId}::text)
 AND NOT EXISTS(SELECT 1 FROM claus_credit_requests WHERE provider_request_id=${requestId}::text) RETURNING id`;return rows.length===1;
}
export async function finishCredit(db,id,{status,response=null,outcome=null,amount:cost=null}={}){
 const n=cost===null?null:amount(cost);
 if(!validId(id)||!['completed','failed','uncertain'].includes(status)||(cost!==null&&n===null))throw Error('invalid_credit_work_finish');
 const encoded=JSON.stringify(response),o=JSON.stringify(outcome);if(encoded===undefined||o===undefined)throw Error('invalid_credit_work_finish');
 const rows=await db`WITH locked AS MATERIALIZED(SELECT id FROM claus_payment_budget WHERE id=true AND ceiling IN (100000000,500000000) FOR UPDATE),finished AS(
  UPDATE claus_credit_work SET status=CASE WHEN ${cost}::bigint>reserved_max THEN 'uncertain' ELSE ${status} END,
   response=CASE WHEN ${cost}::bigint>reserved_max THEN NULL ELSE ${encoded}::jsonb END,outcome=${o}::jsonb,
   accounted_cost=CASE WHEN ${cost}::bigint<=reserved_max THEN ${cost}::bigint END,
   active=CASE WHEN ${cost}::bigint<=reserved_max THEN false WHEN ${cost}::bigint>reserved_max OR ${status}='uncertain' THEN active_until>now() ELSE false END
  FROM locked WHERE claus_credit_work.id=${id} AND status IN ('reserved','submitting') AND accounted_cost IS NULL
  RETURNING reserved_max-COALESCE(accounted_cost,reserved_max) AS released,${cost}::bigint>reserved_max AS overrun
 ),frozen AS(UPDATE claus_credit_work_control SET frozen=true WHERE id=true AND EXISTS(SELECT 1 FROM finished WHERE overrun) RETURNING id)
 UPDATE claus_payment_budget SET committed=committed-finished.released FROM finished WHERE id=true RETURNING id`;
 return rows.length===1;
}
