import {authorized} from '../policy.js';
import {productionCapital} from './service.mjs';
export function installCapitalRoutes(app,{env=process.env,service=()=>productionCapital(env)}={}){
 app.post('/api/capital',async c=>{
  if(env.SERVICE_ROLE!=='operator'||!authorized(c.req.header('authorization'),env.CAPITAL_EXECUTION_SECRET))return c.json({error:'unauthorized'},401);
  try{
   const raw=await c.req.text();if(Buffer.byteLength(raw)>340000)return c.json({error:'request_too_large'},413);
   const body=JSON.parse(raw);if(!body||Object.keys(body).sort().join(',')!=='input,operation'||!['overview','guide','template','source','evidence','review','prepare','advance','status'].includes(body.operation))return c.json({error:'capital_invalid_operation'},400);
   return c.json(await service()[body.operation](body.input));
  }catch(e){return c.json({error:/^capital_[a-z_]+$/.test(e?.message)?e.message:'capital_service_unavailable',outcome:'inspect_original'},409);}
 });
}
