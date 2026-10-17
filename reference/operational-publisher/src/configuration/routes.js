import {missionService} from './missions.js';
import {authorized} from '../policy.js';
import {configurationService} from './service.js';
const configurationMaxBytes=1048576;
export function installConfigurationRoutes(app,{service=()=>configurationService(),missions=()=>missionService(),secret=()=>process.env.NATIVE_CONFIGURATION_OPERATOR_SECRET,enabled=()=>process.env.SERVICE_ROLE==='operator'&&!!process.env.NATIVE_CONFIGURATION_DATABASE_URL}={}){
 const gate=async(c,next)=>{c.header('Cache-Control','no-store');if(!authorized(c.req.header('authorization'),secret()))return c.json({error:'unauthorized'},401);if(!enabled())return c.json({error:'configuration_unavailable'},503);return next();};
 const safe=(c,error)=>{const message=error instanceof Error?error.message:'';const code=/^configuration_(conflict|not_found|invalid_revision|invalid_request|invalid)$/.test(message)?message:error instanceof SyntaxError?'configuration_invalid':'configuration_unavailable';return c.json({error:code},code==='configuration_conflict'?409:code==='configuration_not_found'?404:code==='configuration_unavailable'?503:400);};
 const missionSafe=(c,error)=>{const code=/^mission_(invalid|conflict|not_found)$/.test(error?.message)?error.message:error instanceof SyntaxError?'mission_invalid':'mission_unavailable';return c.json({error:code},code==='mission_conflict'?409:code==='mission_not_found'?404:code==='mission_invalid'?400:503);};
 app.get('/api/native-missions/:id',gate,async c=>{try{return c.json(await missions().read(c.req.param('id')));}catch(error){return missionSafe(c,error);}});
 app.post('/api/native-missions',gate,async c=>{try{if(Number(c.req.header('content-length')??0)>70000)return c.json({error:'request_too_large'},413);const raw=await c.req.text();if(Buffer.byteLength(raw)>70000)return c.json({error:'request_too_large'},413);return c.json(await missions().assign(JSON.parse(raw)));}catch(error){return missionSafe(c,error);}});
 app.get('/api/native-configuration',gate,async c=>{try{return c.json(await service().read());}catch(error){return safe(c,error);}});
 app.get('/api/native-configuration/:revision',gate,async c=>{try{return c.json(await service().read(Number(c.req.param('revision'))));}catch(error){return safe(c,error);}});
 app.put('/api/native-configuration',gate,async c=>{try{if(Number(c.req.header('content-length')??0)>configurationMaxBytes)return c.json({error:'request_too_large'},413);const raw=await c.req.text();if(Buffer.byteLength(raw)>configurationMaxBytes)return c.json({error:'request_too_large'},413);return c.json(await service().update(JSON.parse(raw)));}catch(error){return safe(c,error);}});
}
