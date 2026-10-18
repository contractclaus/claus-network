// One locked budget row serializes each grant's reservations, releases and dispatches.
// Provider-unknown and dispatched amounts remain allocated for this grant's lifetime.
import {createHash} from 'node:crypto';
const hash=v=>createHash('sha256').update(v).digest('hex');
const table='claus_publisher_actions';
const key=(kind,id)=>'owned:'+kind+':'+id;
const scope=`s.result->>'kind'='broker-grant' AND s.result->>'status'='active'
 AND (s.result->>'version')::int=$4::int
 AND (s.result->>'expiresAt')::timestamptz>now()
 AND s.result->'rules'->'resourceIds' ? $5::text
 AND s.result->'rules'->'operations' ? 'endpoint_invoke'
 AND ($7::text IS NULL OR s.result->'rules'->'secretIds' ? $7::text)`;
function args(r){
 if(!/^sec_[a-f0-9]{24}$/.test(r.grantId)||!/^act_[a-f0-9]{24}$/.test(r.actionId)||!/^res_[a-f0-9]{24}$/.test(r.resourceId)||!Number.isSafeInteger(r.version)||r.version<1||typeof r.maximum!=='string'||!/^(0|[1-9][0-9]{0,8})$/.test(r.maximum)||BigInt(r.maximum)>200000000n)throw Error('resource_grant_spend_invalid');
 return [key('grant-budget',r.grantId),key('grant-spend',r.grantId+':'+r.actionId),key('secret',r.grantId),r.version,r.resourceId,r.maximum,r.secretId??null,key('action',r.actionId)];
}
export function grantSpending(sql){
 return {
  async grantBudget(grantId){
   const rows=await sql.query(`SELECT s.result->'rules'->>'maximumSpendMicroUsd' AS maximum,
    COALESCE(b.result->>'allocatedMicroUsd','0') AS allocated FROM ${table} s
    LEFT JOIN ${table} b ON b.id=$2 WHERE s.id=$1`,[key('secret',grantId),key('grant-budget',grantId)]);
   if(!rows[0])throw Error('resource_grant_unknown');
   const maximum=rows[0].maximum??'0',allocated=rows[0].allocated;
   return {grantId,maximumSpendMicroUsd:maximum,allocatedMicroUsd:allocated,remainingMicroUsd:String(BigInt(maximum)-BigInt(allocated)),basis:'Lifetime maximum exposure; includes dispatched and unknown outcomes, not an invoice.'};
  },
  async reserveGrant(r){
   const p=args(r);
   await sql.query(`INSERT INTO ${table}(id,input_hash,status,result)
    SELECT $1, $3, 'completed', jsonb_build_object('maximumSpendMicroUsd',COALESCE(result->'rules'->>'maximumSpendMicroUsd','0'),'allocatedMicroUsd','0')
    FROM ${table} WHERE id=$2 AND result->>'kind'='broker-grant' ON CONFLICT DO NOTHING`,[p[0],p[2],hash(p[0])]);
   const rows=await sql.query(`WITH locked AS MATERIALIZED (
    SELECT b.id,b.result FROM ${table} b JOIN ${table} s ON s.id=$3
    WHERE b.id=$1 AND ${scope} FOR UPDATE OF b,s
   ), reserved AS (
    INSERT INTO ${table}(id,input_hash,status,result)
    SELECT $2,$9,'completed',jsonb_build_object('resourceId',$5::text,'maximumMicroUsd',$6::text,'state','reserved')
    FROM locked WHERE (result->>'allocatedMicroUsd')::bigint+$6::bigint<=(result->>'maximumSpendMicroUsd')::bigint
     AND EXISTS(SELECT 1 FROM ${table} WHERE id=$8 AND status='reserved' AND result->>'phase'='prepared'
      AND result->'prepared'->>'principal'=substring($3::text from 14))
    ON CONFLICT(id) DO UPDATE SET result=EXCLUDED.result,updated_at=now()
     WHERE ${table}.result->>'state'='released' AND ${table}.result->>'resourceId'=$5
      AND ${table}.result->>'maximumMicroUsd'=$6
    RETURNING id
   ) UPDATE ${table} b SET result=jsonb_set(b.result,'{allocatedMicroUsd}',to_jsonb(((l.result->>'allocatedMicroUsd')::bigint+$6::bigint)::text)),updated_at=now()
    FROM locked l,reserved WHERE b.id=l.id RETURNING b.id`,[...p,hash(p[1])]);
   if(rows.length)return;
   const existing=await sql.query(`SELECT result FROM ${table} WHERE id=$1`,[p[1]]);
   if(existing[0]?.result.resourceId===r.resourceId&&existing[0]?.result.maximumMicroUsd===r.maximum&&['reserved','dispatched'].includes(existing[0]?.result.state))return;
   throw Error('resource_grant_budget_or_scope_denied');
  },
  async releaseGrant(r){
   const p=args(r);
   await sql.query(`WITH locked AS MATERIALIZED (
    SELECT id,result FROM ${table} WHERE id=$1 FOR UPDATE
   ), released AS (
    UPDATE ${table} e SET result=jsonb_set(e.result,'{state}','"released"'::jsonb),updated_at=now()
    FROM locked WHERE e.id=$2 AND e.result->>'state'='reserved' AND e.result->>'resourceId'=$3 AND e.result->>'maximumMicroUsd'=$4
     AND EXISTS(SELECT 1 FROM ${table} WHERE id=$5 AND status='reserved' AND result->>'phase'='prepared') RETURNING e.id
   ) UPDATE ${table} b SET result=jsonb_set(b.result,'{allocatedMicroUsd}',to_jsonb(((l.result->>'allocatedMicroUsd')::bigint-$4::bigint)::text)),updated_at=now()
    FROM locked l,released WHERE b.id=l.id`,[p[0],p[1],p[4],p[5],p[7]]);
  },
  async dispatchGrant(r){
   const p=args(r);
   const rows=await sql.query(`WITH resource AS MATERIALIZED (
    SELECT result FROM ${table} WHERE id='owned:resource:'||$5::text FOR SHARE
   ), locked AS MATERIALIZED (
    SELECT b.id,b.result FROM ${table} b JOIN ${table} s ON s.id=$3
    WHERE b.id=$1 AND ${scope} AND EXISTS(SELECT 1 FROM resource WHERE result->>'status'='active') FOR UPDATE OF b,s
   ), spending AS (
    UPDATE ${table} e SET result=jsonb_set(e.result,'{state}','"dispatched"'::jsonb),updated_at=now()
    FROM locked WHERE e.id=$2 AND e.result->>'state'='reserved' AND e.result->>'resourceId'=$5 AND e.result->>'maximumMicroUsd'=$6
     AND EXISTS(SELECT 1 FROM ${table} a WHERE a.id=$8 AND a.status='reserved' AND a.result->>'phase'='prepared' AND a.result->'prepared'->>'principal'=substring($3::text from 14))
    RETURNING e.id
   ) UPDATE ${table} a SET result=jsonb_set(a.result,'{phase}','"dispatched"'::jsonb),updated_at=now()
    FROM spending WHERE a.id=$8 AND a.status='reserved' AND a.result->>'phase'='prepared' RETURNING a.id`,p);
   return rows.length===1;
  }
 };
}
