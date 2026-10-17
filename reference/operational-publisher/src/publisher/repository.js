import {neon} from '@neondatabase/serverless';
import {hash} from './policy.js';
export function publisherRepository(sql=neon(process.env.PUBLISHER_SOURCE_DATABASE_URL)){
 return {
  async surfaceCurrent(){return (await sql`SELECT * FROM claus_surface_control WHERE id`)[0];},
  async surfaceRelease(id){return (await sql`SELECT * FROM claus_surface_releases WHERE id=${id}`)[0];},
  async current(scope){return (await sql`SELECT * FROM claus_operations_control WHERE scope=${scope}`)[0];},
  async release(id){return (await sql`SELECT * FROM claus_operations_releases WHERE id=${id}`)[0];},
  async byDeployment(scope,id){return (await sql`SELECT * FROM claus_operations_releases WHERE scope=${scope} AND (base_deployment=${id} OR deployment->>'id'=${id}) ORDER BY created_at DESC LIMIT 1`)[0];},
  async promotion(scope,base,id){return (await sql`SELECT * FROM claus_operations_releases WHERE scope=${scope} AND ((base_deployment=${base} AND deployment->>'id'=${id}) OR (base_deployment=${id} AND deployment->>'id'=${base})) ORDER BY created_at DESC LIMIT 1`)[0];},
  async review(id){return (await sql`SELECT id,project_id,kind,status,input,output,amount FROM claus_build_effects WHERE id=${id}`)[0];},
  async settings(){const r=(await sql`SELECT content->'settings' AS settings,content->'policy'->'capabilities' AS capabilities FROM claus_config ORDER BY revision DESC LIMIT 1`)[0];return {enabled:r?.settings?.enabled===true&&r.settings.networkOperations?.enabled===true&&r.settings.builder?.enabled===true&&r.capabilities?.networkBuild===true};}
 };
}
export function publisherLedger(sql=neon(process.env.DATABASE_URL)){
 return {
  async get(id){return (await sql`SELECT * FROM claus_publisher_actions WHERE id=${id}`)[0]??null;},
  async reserve(id,input){const h=hash(input),rows=await sql`INSERT INTO claus_publisher_actions(id,input_hash,status) VALUES(${id},${h},'reserved') ON CONFLICT DO NOTHING RETURNING *`;const row=rows[0]??(await sql`SELECT * FROM claus_publisher_actions WHERE id=${id}`)[0];if(row.input_hash!==h)throw Error('publisher_request_conflict');return {created:rows.length===1,row};},
  // Store the immutable OCI context atomically with its reservation. A legacy
  // reservation without this phase is uncertain and can never be re-dispatched.
  async reserveOci(id,input,result){const h=hash(input),rows=await sql`INSERT INTO claus_publisher_actions(id,input_hash,status,result) VALUES(${id},${h},'reserved',${JSON.stringify(result)}::jsonb) ON CONFLICT DO NOTHING RETURNING *`;const row=rows[0]??(await sql`SELECT * FROM claus_publisher_actions WHERE id=${id}`)[0];if(row.input_hash!==h)throw Error('publisher_request_conflict');return {created:rows.length===1,row};},
  async startOciDispatch(id){return (await sql`UPDATE claus_publisher_actions SET result=jsonb_set(result,'{phase}','"dispatching"'::jsonb),updated_at=now() WHERE id=${id} AND status='reserved' AND result->>'phase'='prepared' RETURNING id`).length===1;},
  async checkpoint(id,result){await sql`UPDATE claus_publisher_actions SET result=${JSON.stringify(result)}::jsonb,updated_at=now() WHERE id=${id} AND status='reserved'`;},
  async complete(id,result){await sql`UPDATE claus_publisher_actions SET status='completed',result=${JSON.stringify(result)}::jsonb,updated_at=now() WHERE id=${id}`;}
 };
}
