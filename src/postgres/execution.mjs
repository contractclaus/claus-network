// Aggregate public execution evidence in PostgreSQL. Private inputs, outputs,
// project IDs and provider handles never leave the database in this query.
export function executionSummaryQuery(documents){
 const time=field=>`CASE WHEN jsonb_typeof(${field})='number' AND (${field}#>>'{}') ~ '^[0-9]{1,16}$' THEN CASE WHEN (${field}#>>'{}')::numeric<=9007199254740991 THEN (${field}#>>'{}')::bigint END END`;
 return `SELECT state, count(*)::text AS count,
 count(*) FILTER (WHERE finished_at BETWEEN $1::bigint-86400000 AND $1::bigint)::text AS recent_count,
 max(finished_at) FILTER (WHERE state='completed' AND finished_at<=$1::bigint)::text AS last_completed_at,
 count(*) FILTER (WHERE state='running' AND lease_until<=$1::bigint)::text AS overdue
 FROM (SELECT body->>'state' AS state,${time("body->'finishedAt'")} AS finished_at,${time("body->'lease'->'until'")} AS lease_until FROM ${documents} WHERE collection='worker-runs') runs GROUP BY state`;
}
