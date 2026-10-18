import {authorized} from '../policy.js';
import {publisherRepository,publisherLedger} from '../publisher/repository.js';
import {createWebsiteAdmin} from './service.mjs';
let instance;
export function installWebsiteAdmin(app){app.post('/api/website-admin',async c=>{
 if(process.env.SERVICE_ROLE!=='operator'||process.env.PUBLISHER_ENABLED!=='true')return c.json({error:'website_disabled'},403);
 if(!authorized(c.req.header('authorization'),process.env.PUBLISHER_SECRET))return c.json({error:'unauthorized'},401);
 try{const raw=await c.req.text();if(Buffer.byteLength(raw)>120000)return c.json({error:'request_too_large'},413);const v=JSON.parse(raw);if(!v||typeof v.operation!=='string'||typeof v.requestId!=='string'||v.requestId.length>200||!v.input||typeof v.input!=='object')return c.json({error:'website_input_invalid'},400);instance??=createWebsiteAdmin({repository:publisherRepository(),ledger:publisherLedger()});return c.json({result:await instance.call(v.operation,v.input,v.requestId)});}
 catch(e){return c.json({error:/^website_[a-z_]+$/.test(e?.message??'')?e.message:'website_operation_unavailable'},409);}
});}
