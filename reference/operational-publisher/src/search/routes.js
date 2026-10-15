import {authorized} from '../policy.js';
import {SearchError,limitedJSON} from './policy.js';
import {createSearch} from './service.js';
import {searchRepository} from './repository.js';
let production;
export function installSearchRoutes(app,{enabled=()=>process.env.SERVICE_ROLE==='operator'&&process.env.SEARCH_ENABLED==='true'&&!!process.env.BRAVE_SEARCH_API_KEY,secret=()=>process.env.SEARCH_CLIENT_SECRET,service=()=>production??=createSearch({repository:searchRepository()})}={}){
 const gate=async(c,next)=>{c.header('Cache-Control','no-store');if(!authorized(c.req.header('authorization'),secret()))return c.json({error:'unauthorized'},401);if(!enabled())return c.json({error:'search_not_connected'},503);return next();};
 const failure=(c,e)=>c.json({error:e instanceof SearchError?e.message:'search_broker_unavailable'},e instanceof SearchError?e.status:503);
 app.get('/api/search/status',gate,async c=>{try{return c.json(await service().status());}catch(e){return failure(c,e);}});
 app.post('/api/search',gate,async c=>{try{return c.json(await service().search(await limitedJSON(c.req.raw,4096)));}catch(e){return failure(c,e);}});
}
