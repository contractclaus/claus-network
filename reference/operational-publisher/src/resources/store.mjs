import {resourceReferences} from './retirement.mjs';
import {grantSpending} from './grant-spending.mjs';
import {neon} from '@neondatabase/serverless';
import {createHash} from 'node:crypto';
export const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const ordered=v=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v;
export const sameValue=(a,b)=>JSON.stringify(ordered(a))===JSON.stringify(ordered(b));
const key=(kind,id)=>'owned:'+kind+':'+id;
const infrastructureProjection="jsonb_build_object('id',id,'originalResourceId',result->'work'->'id','projectId',result->'work'->'projectId','provider',result->'providerConfig'->'provider','app',result->'providerConfig'->'app','providerResourceId',result->'providerResourceId','image',result->'work'->'manifest'->'image','leaseUntil',result->'leaseUntil','state',result->'state','phase',result->'phase','terminal',COALESCE(result->'terminal','false'::jsonb),'stopped',COALESCE(result->'stopped','false'::jsonb),'observedAt',result->'observedAt','networkVolume',result->'work'->'manifest'->'networkVolume')";
export function resourceStore(sql=neon(process.env.DATABASE_URL)){
 return {
  ...grantSpending(sql),
  async latestAccountCosts(){const rows=await sql`SELECT jsonb_build_object('provider',result->'provider','account',result->'account','observedAt',result->'observedAt','requested',result->'requested','sourceSha256',result->'sourceSha256','dataFrom',result->'dataFrom','dataThrough',result->'dataThrough','unreportedInterval',result->'unreportedInterval','totals',result->'totals','projects',result->'projects','services',result->'services') AS value FROM claus_publisher_actions WHERE id LIKE 'owned:account-cost-observation:%' AND result->'requested'->>'projectId' IS NULL ORDER BY created_at DESC,id DESC LIMIT 1`;return {latest:rows[0]?.value??null,freshlyRequested:false,meaning:'Latest retained authenticated account export, with its original observation time and reporting gaps. Refresh explicitly using account_costs. Other invoices remain unknown.'};},
  async infrastructureLeases(offset=0){const rows=await sql.query("SELECT "+infrastructureProjection+" AS value FROM claus_publisher_actions WHERE id LIKE 'infrastructure:sha256:%' ORDER BY created_at,id LIMIT 51 OFFSET $1",[offset]);return {items:rows.slice(0,50).map(r=>r.value),nextOffset:rows.length>50?offset+50:null};},
  async infrastructureMatches(machines){const ids=machines.map(x=>x.id),originals=machines.map(x=>x.originalResourceId).filter(Boolean),names=machines.filter(x=>x.provider==='runpod').map(x=>x.name).filter(Boolean);const rows=await sql.query("SELECT "+infrastructureProjection+" AS value FROM claus_publisher_actions WHERE id LIKE 'infrastructure:sha256:%' AND (result->>'providerResourceId'=ANY($1::text[]) OR result->'work'->>'id'=ANY($2::text[]) OR 'claus-'||right(result->'work'->>'id',40)=ANY($3::text[]))",[ids,originals,names]);return rows.map(r=>r.value);},
  async queueLoad(resourceId){
   const rows=await sql`SELECT
    count(*) FILTER (WHERE a.result->>'state'=ANY(ARRAY['queued','waiting']) AND (a.result->>'nextAt')::timestamptz<=now() AND NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements_text(COALESCE(a.result->'dependencies','[]'::jsonb)) d(id)
     LEFT JOIN claus_publisher_actions dependency ON dependency.id='owned:job:'||${resourceId}||':'||d.id
     WHERE dependency.result->>'state' IS DISTINCT FROM 'succeeded'))::int AS backlog,
    count(*) FILTER (WHERE a.result->>'state'=ANY(ARRAY['running','reconciling','accepted']) OR a.result->>'state'='blocked' AND a.result->>'reason'='original_response_unknown')::int AS busy
    FROM claus_publisher_actions a WHERE a.id LIKE ${'owned:job:'+resourceId+':%'}`;
   return {backlog:rows[0].backlog,busy:rows[0].busy};
  },
  async jobs(resourceId,states=[],offset=0,due=false){const rows=await sql`SELECT result FROM claus_publisher_actions WHERE id LIKE ${'owned:job:'+resourceId+':%'} AND (cardinality(${states}::text[])=0 OR result->>'state'=ANY(${states}::text[])) AND (NOT ${due} OR (result->>'nextAt')::timestamptz<=now()) ORDER BY (result->>'nextAt')::timestamptz,created_at,id LIMIT 51 OFFSET ${offset}`;return {items:rows.slice(0,50).map(r=>r.result),nextOffset:rows.length>50?offset+50:null};},
  async get(kind,id){return (await sql`SELECT result FROM claus_publisher_actions WHERE id=${key(kind,id)}`)[0]?.result??null;},
  async list(kind,offset=0){const rows=await sql`SELECT id,result FROM claus_publisher_actions WHERE id LIKE ${'owned:'+kind+':%'} ORDER BY created_at,id LIMIT 51 OFFSET ${offset}`;return {items:rows.slice(0,50).map(r=>kind==='action'?{...r.result,actionId:r.id.slice(13)}:r.result),nextOffset:rows.length>50?offset+50:null};},
  async put(kind,id,value){const rows=await sql`INSERT INTO claus_publisher_actions(id,input_hash,status,result) VALUES(${key(kind,id)},${digest([kind,id])},'completed',${JSON.stringify(value)}::jsonb) ON CONFLICT DO NOTHING RETURNING result`;return {created:rows.length===1,value:rows[0]?.result??await this.get(kind,id)};},
  async change(kind,id,revision,value){const rows=await sql`UPDATE claus_publisher_actions SET result=${JSON.stringify(value)}::jsonb,updated_at=now() WHERE id=${key(kind,id)} AND (result->>'revision')::int=${revision} RETURNING result`;if(!rows.length)throw Error('resource_revision_conflict');return rows[0].result;},
  async begin(id,operation,input,prepared){const h=digest({operation,input});const rows=await sql`INSERT INTO claus_publisher_actions(id,input_hash,status,result) VALUES(${key('action',id)},${h},'reserved',${JSON.stringify({operation,input,prepared,phase:'prepared'})}::jsonb) ON CONFLICT DO NOTHING RETURNING *`;const row=rows[0]??(await sql`SELECT * FROM claus_publisher_actions WHERE id=${key('action',id)}`)[0];if(row.input_hash!==h&&(row.result?.operation!==operation||!sameValue(row.result.input,input)))throw Error('resource_request_conflict');return {created:rows.length===1,row};},
  async dispatch(id,delegation=null){
   const action=await this.get('action',id);if(!action)return false;
   const refs=resourceReferences([action.input,action.prepared]).map(id=>key('resource',id));
   const plan=action.operation==='retirement_provider'?action.input?.planId:null;
   const specialist=action.prepared?.modelSpecialist??null;
   const rows=await sql.query(`WITH resources AS MATERIALIZED (
    SELECT result FROM claus_publisher_actions WHERE id=ANY($2::text[]) ORDER BY id FOR SHARE
   ), grant_row AS MATERIALIZED (
    SELECT result FROM claus_publisher_actions WHERE id='owned:secret:'||$4::text FOR SHARE
   ), specialist_row AS MATERIALIZED (
    SELECT result FROM claus_publisher_actions WHERE id='owned:model-specialist:'||$6::text FOR SHARE
   ) UPDATE claus_publisher_actions SET result=jsonb_set(result,'{phase}','"dispatched"'::jsonb),updated_at=now()
    WHERE id=$1 AND status='reserved' AND (result->>'phase'='prepared' OR result->>'phase'='provider_retry' AND (result->>'retryAt')::timestamptz<=now())
     AND NOT EXISTS(SELECT 1 FROM resources WHERE (result ? 'retirementPlanId' OR result->>'status'=ANY(ARRAY['retiring','retired','removed','archived'])) AND ($3::text IS NULL OR result->>'retirementPlanId' IS DISTINCT FROM $3))
     AND ($4::text IS NULL OR EXISTS(SELECT 1 FROM grant_row WHERE result->>'kind'='broker-grant' AND result->>'status'='active' AND (result->>'version')::int=$5::int AND (result->>'expiresAt')::timestamptz>now()))
     AND ($6::text IS NULL OR EXISTS(SELECT 1 FROM specialist_row WHERE result->>'state'='running' AND COALESCE((result->>'stopRequested')::boolean,false)=false AND (result->>'turn')::int=$7::int AND (result->>'deadline')::timestamptz>now()))
    RETURNING id`,[key('action',id),refs,plan,delegation?.id??null,delegation?.version??null,specialist?.id??null,specialist?.turn??null]);return rows.length===1;
  },
  async deferRejected(id,retryAt){if(!Number.isFinite(Date.parse(retryAt)))throw Error('resource_retry_time_invalid');const rows=await sql`UPDATE claus_publisher_actions SET result=result||${JSON.stringify({phase:'provider_retry',retryAt})}::jsonb,updated_at=now() WHERE id=${key('action',id)} AND status='reserved' AND result->>'phase'='dispatched' AND result->>'operation'=ANY(${['repository_merge_apply','volume_create','volume_resize','repository_fastforward','repository_release_prepare','repository_release_publish','project_domain_add','project_domain_verify','project_domain_remove']}::text[]) RETURNING id`;if(rows.length!==1)throw Error('resource_retry_state_conflict');},
  async complete(id,result){await sql`UPDATE claus_publisher_actions SET status='completed',result=jsonb_set(result,'{output}',${JSON.stringify(result)}::jsonb),updated_at=now() WHERE id=${key('action',id)}`;return result;}
 };
}
