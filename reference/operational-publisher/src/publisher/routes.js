import {authorized} from '../policy.js';
import {OperationsHostError} from './host.js';
import {createPublisher} from './service.js';
import {publisherRepository,publisherLedger} from './repository.js';
let production;
export function installPublisherRoutes(app,{role=()=>process.env.SERVICE_ROLE,secret=()=>process.env.PUBLISHER_SECRET,enabled=()=>process.env.PUBLISHER_ENABLED==='true',service=()=>production??=(createPublisher({repository:publisherRepository(),ledger:publisherLedger()}))}={}){
 app.post('/api/publisher',async c=>{
  if(role()!=='operator'||!enabled())return c.json({error:'publisher_disabled'},403);
  if(!authorized(c.req.header('authorization'),secret()))return c.json({error:'unauthorized'},401);
  try{
   const raw=await c.req.text();if(Buffer.byteLength(raw)>600000)return c.json({error:'request_too_large'},413);
   const v=JSON.parse(raw);if(!v||typeof v!=='object'||Object.keys(v).sort().join(',')!=='args,operation,scope')return c.json({error:'publisher_input_invalid'},400);
   return c.json({result:await service().call(v.operation,v.scope,v.args)});
  }catch(e){
   if(e instanceof OperationsHostError)return c.json({error:'publisher_provider_error',providerStatus:e.status,providerCode:e.code},502);
   return c.json({error:/^(publisher|operations|isolated)_[a-z_]+$/.test(e?.message??'')?e.message:'publisher_unavailable'},409);
  }
 });
}
