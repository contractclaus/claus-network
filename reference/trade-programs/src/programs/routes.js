import {authorized} from '../policy.js';
import {walletRepository} from '../wallet-store.js';
import {productionPrograms} from './service.js';
import {createProgramSourcePublisher} from './source.js';
export function installProgramRoutes(app,{service=productionPrograms,publisher=()=>createProgramSourcePublisher({repositoryStore:walletRepository()}),
 role=()=>process.env.SERVICE_ROLE,secret=()=>process.env.NATIVE_PROGRAM_SECRET,enabled=()=>process.env.NATIVE_PROGRAM_SERVICE_ENABLED==='true'}={}){
 app.use('/api/programs',async(c,next)=>{
  if(role()!=='operator'||!enabled())return c.json({error:'program_service_disabled'},403);
  if(c.req.method!=='POST')return c.json({error:'program_route_denied'},403);
  if(!authorized(c.req.header('authorization'),secret()))return c.json({error:'unauthorized'},401);
  return next();
 });
 app.post('/api/programs',async c=>{
  let operation;
  try{
   const raw=await c.req.text();if(Buffer.byteLength(raw)>340000)return c.json({error:'request_too_large'},413);
   const body=JSON.parse(raw);if(!body||Array.isArray(body)||Object.keys(body).sort().join(',')!=='input,operation')return c.json({error:'program_invalid_input'},400);
   operation=body.operation;const input=body.input;
   if(operation==='overview'){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>k!=='after')||input.after!==undefined&&typeof input.after!=='string')return c.json({error:'program_invalid_input'},400);
    return c.json(await service().overview(input));
   }
   if(operation==='source')return c.json(await publisher().publish(input));
   if(operation==='evidence')return c.json(await service().evidence(input));
   if(operation==='prepare')return c.json(await service().prepare(input));
   if(operation==='receipts'){
    if(!input||Object.keys(input).some(k=>!['id','fromBlock'].includes(k)))return c.json({error:'program_invalid_input'},400);
    return c.json(await service().receipts(input.id,input.fromBlock));
   }
   if(operation==='deliver'){
    if(!input||Object.keys(input).some(k=>!['id','receipt'].includes(k)))return c.json({error:'program_invalid_input'},400);
    return c.json(await service().deliver(input.id,input.receipt));
   }
   if(['status','advance','disable'].includes(operation)){
    if(!input||Object.keys(input).join(',')!=='id')return c.json({error:'program_invalid_input'},400);
    return c.json(await service()[operation](input.id));
   }
   return c.json({error:'program_operation_unavailable'},400);
  }catch(error){return c.json({error:/^program_[a-z_]{1,100}$/.test(error.message)?error.message:'program_service_unavailable',
   outcome:['advance','disable','deliver','source'].includes(operation)?'inspect_original':'not_completed',next:'Read the same source or original program/action id. Do not create a replacement after an uncertain result.'},409);}
 });
}
