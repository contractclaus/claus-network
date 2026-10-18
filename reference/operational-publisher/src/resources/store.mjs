import {neon} from '@neondatabase/serverless';
import {createHash} from 'node:crypto';
export const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const key=(kind,id)=>'owned:'+kind+':'+id;
export function resourceStore(sql=neon(process.env.DATABASE_URL)){
 return {
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
  async list(kind,offset=0){const rows=await sql`SELECT result FROM claus_publisher_actions WHERE id LIKE ${'owned:'+kind+':%'} ORDER BY created_at,id LIMIT 51 OFFSET ${offset}`;return {items:rows.slice(0,50).map(r=>r.result),nextOffset:rows.length>50?offset+50:null};},
  async put(kind,id,value){const rows=await sql`INSERT INTO claus_publisher_actions(id,input_hash,status,result) VALUES(${key(kind,id)},${digest([kind,id])},'completed',${JSON.stringify(value)}::jsonb) ON CONFLICT DO NOTHING RETURNING result`;return {created:rows.length===1,value:rows[0]?.result??await this.get(kind,id)};},
  async change(kind,id,revision,value){const rows=await sql`UPDATE claus_publisher_actions SET result=${JSON.stringify(value)}::jsonb,updated_at=now() WHERE id=${key(kind,id)} AND (result->>'revision')::int=${revision} RETURNING result`;if(!rows.length)throw Error('resource_revision_conflict');return rows[0].result;},
  async begin(id,operation,input,prepared){const h=digest({operation,input});const rows=await sql`INSERT INTO claus_publisher_actions(id,input_hash,status,result) VALUES(${key('action',id)},${h},'reserved',${JSON.stringify({operation,input,prepared,phase:'prepared'})}::jsonb) ON CONFLICT DO NOTHING RETURNING *`;const row=rows[0]??(await sql`SELECT * FROM claus_publisher_actions WHERE id=${key('action',id)}`)[0];if(row.input_hash!==h)throw Error('resource_request_conflict');return {created:rows.length===1,row};},
  async dispatch(id){return (await sql`UPDATE claus_publisher_actions SET result=jsonb_set(result,'{phase}','"dispatched"'::jsonb),updated_at=now() WHERE id=${key('action',id)} AND status='reserved' AND (result->>'phase'='prepared' OR result->>'phase'='provider_retry' AND (result->>'retryAt')::timestamptz<=now()) RETURNING id`).length===1;},
  async deferRejected(id,retryAt){if(!Number.isFinite(Date.parse(retryAt)))throw Error('resource_retry_time_invalid');const rows=await sql`UPDATE claus_publisher_actions SET result=result||${JSON.stringify({phase:'provider_retry',retryAt})}::jsonb,updated_at=now() WHERE id=${key('action',id)} AND status='reserved' AND result->>'phase'='dispatched' AND result->>'operation'=ANY(${['volume_create','volume_resize','repository_fastforward','repository_release_prepare','repository_release_publish','project_domain_add','project_domain_verify','project_domain_remove']}::text[]) RETURNING id`;if(rows.length!==1)throw Error('resource_retry_state_conflict');},
  async complete(id,result){await sql`UPDATE claus_publisher_actions SET status='completed',result=jsonb_set(result,'{output}',${JSON.stringify(result)}::jsonb),updated_at=now() WHERE id=${key('action',id)}`;return result;}
 };
}
