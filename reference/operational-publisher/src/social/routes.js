import {authorized} from '../policy.js';
import {SocialError} from './policy.js';
import {createSocial} from './service.js';
import {socialRepository} from './repository.js';
let production;
export function installSocialRoutes(app,{enabled=()=>process.env.SERVICE_ROLE==='operator'&&!!process.env.SOCIAL_SOURCE_DATABASE_URL,secret=()=>process.env.SOCIAL_CLIENT_SECRET,service=()=>production??=createSocial({repository:socialRepository()})}={}){
 const gate=async(c,next)=>{c.header('Cache-Control','no-store');if(!authorized(c.req.header('authorization'),secret()))return c.json({error:'unauthorized'},401);if(!enabled())return c.json({error:'x_broker_unavailable'},503);return next();};
 const failure=(c,e)=>c.json(e instanceof SocialError?{error:e.message,definite:e.definite,...(e.retryAt?{retryAt:e.retryAt}:{})}:{error:'x_broker_unavailable',definite:false},e instanceof SocialError&&e.definite?409:503);
 app.post('/api/social',gate,async c=>{try{if(Number(c.req.header('content-length')??0)>24000)return c.json({error:'x_request_too_large',definite:true},413);const raw=await c.req.text();if(Buffer.byteLength(raw)>24000)return c.json({error:'x_request_too_large',definite:true},413);return c.json({result:await service().call(JSON.parse(raw))});}catch(e){return failure(c,e);}});
 app.get('/api/social/receipts/:id',gate,async c=>{try{return c.json(await service().receipt(c.req.param('id')));}catch(e){return failure(c,e);}});
}
