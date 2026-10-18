import {authorized} from '../policy.js';
import {publisherRepository} from '../publisher/repository.js';
import {createResourceService} from './service.mjs';
let service;
export function installResources(app){app.post('/api/resources',async c=>{
 if(process.env.SERVICE_ROLE!=='operator'||process.env.PUBLISHER_ENABLED!=='true')return c.json({error:'resource_disabled'},403);
 const owner=authorized(c.req.header('authorization'),process.env.PUBLISHER_SECRET),header=c.req.header('authorization')??'';
 if(!owner&&!/^Bearer claus_sec_[a-f0-9]{24}\.[A-Za-z0-9_-]{43}$/.test(header))return c.json({error:'unauthorized'},401);
 try{
  if(!(await publisherRepository().settings()).enabled)return c.json({error:'resource_disabled'},403);
  const text=await c.req.text();if(Buffer.byteLength(text)>32000)return c.json({error:'resource_request_too_large'},413);
  const v=JSON.parse(text);if(!v||typeof v.operation!=='string')return c.json({error:'resource_input_invalid'},400);
  service??=createResourceService({workStatus:id=>publisherRepository().workStatus(id)});return c.json({result:await service.call(v.operation,v.input??{},v.requestId,{grant:owner?null:header.slice(7)})});
 }catch(e){const code=/^resource_[a-z0-9_]+$/.test(e?.message??'')?e.message:'resource_operation_unavailable';return c.json({error:code,...(e?.retryAt?{retryAt:new Date(e.retryAt).toISOString()}:{}),retry:false},409);}
});}
