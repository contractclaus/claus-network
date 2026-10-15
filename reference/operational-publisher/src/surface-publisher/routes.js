import {authorized} from '../policy.js';
import {createSurfacePublisher} from './service.js';
import {publisherRepository,publisherLedger} from '../publisher/repository.js';
let production;
export function installSurfacePublisherRoutes(app,{role=()=>process.env.SERVICE_ROLE,secret=()=>process.env.PUBLISHER_SECRET,enabled=()=>process.env.PUBLISHER_ENABLED==='true'&&!!process.env.PUBLISHER_SURFACE_TOKEN,service=()=>production??=createSurfacePublisher({repository:publisherRepository(),ledger:publisherLedger()})}={}){
 app.post('/api/surface-publisher',async c=>{
  if(role()!=='operator'||!enabled())return c.json({error:'surface_publisher_disabled'},403);
  if(!authorized(c.req.header('authorization'),secret()))return c.json({error:'unauthorized'},401);
  try{
   const raw=await c.req.text();if(Buffer.byteLength(raw)>500000)return c.json({error:'surface_request_too_large'},413);
   const v=JSON.parse(raw);if(!v||typeof v!=='object'||Object.keys(v).sort().join(',')!=='args,operation')return c.json({error:'surface_input_invalid'},400);
   return c.json({result:await service().call(v.operation,v.args)});
  }catch(error){return c.json({error:/^surface_[a-z_0-9]+$/.test(error?.message??'')?error.message:'surface_publisher_unavailable'},409);}
 });
}
