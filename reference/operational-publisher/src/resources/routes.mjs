import {authorized} from '../policy.js';
import {publisherRepository} from '../publisher/repository.js';
import {createResourceService} from './service.mjs';
let service;
const current=()=>service??=createResourceService({workStatus:id=>publisherRepository().workStatus(id)});
export async function processResourceQueues(){
 if(process.env.SERVICE_ROLE!=='operator'||process.env.PUBLISHER_ENABLED!=='true'||!(await publisherRepository().settings()).enabled)return {state:'disabled'};
 const queues=await current().tickQueues();const volumes=await current().tickVolumes().catch(()=>({state:'unavailable'}));const specialists=await current().tickSpecialists().catch(()=>({state:'unavailable'}));return {...queues,volumes,specialists};
}
export function installResources(app){
 app.get('/api/resources/observation',async c=>{
  if(process.env.SERVICE_ROLE!=='operator'||!process.env.RESOURCE_OBSERVER_SECRET)return c.json({error:'observation_unconfigured'},503);
  if(!authorized(c.req.header('authorization'),process.env.RESOURCE_OBSERVER_SECRET))return c.json({error:'unauthorized'},401);
  try{const enabled=process.env.PUBLISHER_ENABLED==='true'&&(await publisherRepository().settings()).enabled;
   return c.json(await current().observe({enabled,native:()=>publisherRepository().operationalObservation()}));
  }catch{return c.json({error:'observation_unavailable'},503);}
 });
 app.post('/api/resource-events/:resourceId',async c=>{
  if(process.env.SERVICE_ROLE!=='operator'||process.env.PUBLISHER_ENABLED!=='true')return c.json({error:'resource_disabled'},403);
  try{
   if(!(await publisherRepository().settings()).enabled)return c.json({error:'resource_disabled'},403);
   const raw=await c.req.text();if(Buffer.byteLength(raw)>1000000)return c.json({error:'resource_request_too_large'},413);
   const result=await current().webhook(c.req.param('resourceId'),{timestamp:c.req.header('x-claus-timestamp'),eventId:c.req.header('x-claus-event-id'),signature:c.req.header('x-claus-signature'),raw});
   return c.json({jobId:result.id,state:result.state,duplicateSafe:true},202);
  }catch{return c.json({error:'resource_event_refused'},400);}
 });
 app.post('/api/resources',async c=>{
 if(process.env.SERVICE_ROLE!=='operator'||process.env.PUBLISHER_ENABLED!=='true')return c.json({error:'resource_disabled'},403);
 const owner=authorized(c.req.header('authorization'),process.env.PUBLISHER_SECRET),header=c.req.header('authorization')??'';
 if(!owner&&!/^Bearer claus_sec_[a-f0-9]{24}\.[A-Za-z0-9_-]{43}$/.test(header))return c.json({error:'unauthorized'},401);
 try{
  if(!(await publisherRepository().settings()).enabled)return c.json({error:'resource_disabled'},403);
  const text=await c.req.text();if(Buffer.byteLength(text)>4400000)return c.json({error:'resource_request_too_large'},413);
  const v=JSON.parse(text);if(!v||typeof v.operation!=='string')return c.json({error:'resource_input_invalid'},400);
  return c.json({result:await current().call(v.operation,v.input??{},v.requestId,{grant:owner?null:header.slice(7)})});
 }catch(e){const code=/^resource_[a-z0-9_]+$/.test(e?.message??'')?e.message:'resource_operation_unavailable';return c.json({error:code,...(e?.retryAt?{retryAt:new Date(e.retryAt).toISOString()}:{}),retry:false},409);}
});}
