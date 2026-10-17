import {authorized} from '../policy.js';
import {publisherLedger} from '../publisher/repository.js';
import {createGithub} from './service.mjs';
export function installGithubRoutes(app,{service,secret=()=>process.env.PUBLISHER_SECRET}={}){
 let live;
 app.post('/api/github',async c=>{
  if(process.env.SERVICE_ROLE!=='operator'||!process.env.CLAUS_GITHUB_TOKEN)return c.json({error:'github_not_configured'},503);
  if(!authorized(c.req.header('authorization'),secret()))return c.json({error:'unauthorized'},401);
  try{const text=await c.req.text();if(Buffer.byteLength(text)>12000)return c.json({error:'request_too_large'},413);
   const result=await (service??(live??=createGithub({ledger:publisherLedger()})))(JSON.parse(text));return c.json({result});
  }catch(error){return c.json({error:/^github_[a-z_0-9]+$/.test(error?.message??'')?error.message:'github_outcome_unknown'},409);}
 });
}
