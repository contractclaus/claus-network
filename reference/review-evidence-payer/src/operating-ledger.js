// Projection only: never expire a request, settle a payment, or release a hold.
export async function operatingLedger(db){
 const rows=await db`WITH entries AS (
  SELECT 'inference' AS source,id,reserved_max AS maximum,accounted_cost AS accounted,accounted_cost AS actual,capital_accounted_at AS accounted_at FROM claus_inference
  UNION ALL SELECT 'credit-work',id,reserved_max,accounted_cost,accounted_cost,capital_accounted_at FROM claus_credit_work
  UNION ALL SELECT 'credit-requests',id,reserved_max,accounted_cost,accounted_cost,capital_accounted_at FROM claus_credit_requests
  UNION ALL SELECT 'operating-'||CASE WHEN id LIKE 'infrastructure:%' THEN 'lease' ELSE split_part(id,':',4) END,id,maximum,
   CASE WHEN state='committed' THEN maximum WHEN state='cancelled' THEN 0 ELSE NULL END,
   CASE WHEN state='cancelled' THEN 0 ELSE NULL END,accounted_at FROM claus_operating_commitments
 ) SELECT source,count(*)::int AS records,count(*) FILTER(WHERE accounted IS NULL)::int AS unresolved,
  COALESCE(sum(maximum) FILTER(WHERE accounted IS NULL),0)::text AS held,
  COALESCE(sum(accounted) FILTER(WHERE accounted_at>now()-interval '24 hours'),0)::text AS authorization_24h,
  COALESCE(sum(accounted) FILTER(WHERE accounted_at>now()-interval '30 days'),0)::text AS authorization_30d,
  COALESCE(sum(actual) FILTER(WHERE accounted_at>now()-interval '24 hours'),0)::text AS actual_24h,
  COALESCE(sum(actual) FILTER(WHERE accounted_at>now()-interval '30 days'),0)::text AS actual_30d,
  COALESCE(sum(accounted) FILTER(WHERE actual IS NULL AND accounted_at>now()-interval '24 hours'),0)::text AS maximum_only_24h,
  COALESCE(sum(accounted) FILTER(WHERE actual IS NULL AND accounted_at>now()-interval '30 days'),0)::text AS maximum_only_30d
 FROM entries GROUP BY source ORDER BY source`;
 const total=key=>rows.reduce((n,r)=>n+BigInt(r[key]),0n).toString();
 return {version:1,observedAt:new Date().toISOString(),unit:'microUSD',sources:rows,totals:{unresolved:rows.reduce((n,r)=>n+r.unresolved,0),held:total('held'),authorization24h:total('authorization_24h'),authorization30d:total('authorization_30d'),actualRecorded24h:total('actual_24h'),actualRecorded30d:total('actual_30d'),maximumOnly24h:total('maximum_only_24h'),maximumOnly30d:total('maximum_only_30d')},readOnly:true,holdsChanged:false,meaning:'Actual recorded request cost, unresolved maximum exposure and committed maximum authorizations are separate. Maximum-only authorizations are not provider invoices. Provider credit and wallet transfers are not added as consumption. External account invoices can overlap these authorizations and are not blindly summed.'};
}
