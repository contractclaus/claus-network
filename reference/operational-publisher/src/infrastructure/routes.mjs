import {authorized} from '../policy.js';
import {publisherLedger} from '../publisher/repository.js';
import {createInfrastructureBroker} from './broker.mjs';

export function installInfrastructureRoutes(app){
  let broker;
  const current=()=>broker??=createInfrastructureBroker({ledger:publisherLedger()});
  app.post('/api/infrastructure',async c=>{
    if(process.env.SERVICE_ROLE!=='operator')return c.json({error:'infrastructure_not_configured'},503);
    if(!authorized(c.req.header('authorization'),process.env.CLAUS_OCI_NETWORK_SECRET))return c.json({error:'unauthorized'},401);
    try{
      const raw=await c.req.text();if(Buffer.byteLength(raw)>24000)return c.json({error:'request_too_large'},413);
      return c.json({result:await current().call(JSON.parse(raw))});
    }catch(e){return c.json({error:/^infrastructure_[a-z0-9_]+$/.test(e?.message??'')?e.message:'infrastructure_outcome_unknown'},409);}
  });
  app.get('/api/infrastructure/guardian',async c=>{
    if(process.env.SERVICE_ROLE!=='operator')return c.json({error:'infrastructure_not_configured'},503);
    if(!authorized(c.req.header('authorization'),process.env.CRON_SECRET))return c.json({error:'unauthorized'},401);
    c.header('Cache-Control','no-store');
    try{return c.json(await current().guard());}catch{return c.json({error:'infrastructure_guard_unavailable'},503);}
  });
}
