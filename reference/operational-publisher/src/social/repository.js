import {neon} from '@neondatabase/serverless';
import {digest,SocialError} from './policy.js';
export function socialRepository(source=neon(process.env.SOCIAL_SOURCE_DATABASE_URL),db=neon(process.env.DATABASE_URL)){
 return {
  async config(){return (await source`SELECT content FROM claus_social_config ORDER BY revision DESC LIMIT 1`)[0]?.content;},
  async source(id){const action=(await source`SELECT * FROM claus_social_actions WHERE id=${id}`)[0];const config=(await this.config());const optedOut=action?.input?.replyAuthorId?(await source`SELECT author_id FROM claus_social_optouts WHERE author_id=${action.input.replyAuthorId}` ).length>0:false;return {action,config,optedOut};},
  async asset(ref){return (await source`SELECT base64,sha256,category FROM claus_social_assets WHERE id=${ref}`)[0];},
  async get(id){return (await db`SELECT * FROM claus_social_effects WHERE id=${id}`)[0];},
  async reserve(id,input){const hash=digest(input),rows=await db`INSERT INTO claus_social_effects(id,input_hash,status) VALUES(${id},${hash},'started') ON CONFLICT DO NOTHING RETURNING *`;const row=rows[0]??await this.get(id);if(row?.input_hash!==hash)throw new SocialError('x_request_id_conflict',true);return {created:rows.length===1,row};},
  async complete(id,response){await db`UPDATE claus_social_effects SET status='completed',response=${JSON.stringify(response)}::jsonb,completed_at=now() WHERE id=${id} AND status='started'`;},
  async reject(id,error){await db`UPDATE claus_social_effects SET status='failed',response=${JSON.stringify({error:error.message,definite:true,retryAt:error.retryAt})}::jsonb,completed_at=now() WHERE id=${id} AND status='started'`;}
 };
}
