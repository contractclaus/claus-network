import {authorized} from '../policy.js';
import {createNetworkAccess} from './network.js';
import {workWallet} from './work-wallet.js';
const network=createNetworkAccess();
export function jobsRoute(path){return path==='/api/jobs/wallet'||path==='/api/jobs/session';}
export function installJobsRoutes(app,{wallet=workWallet,session=input=>network.session(input),enabled=()=>process.env.JOBS_WALLET_ENABLED==='true',secret=()=>process.env.JOBS_WALLET_SECRET}={}){
 // A separate credential exposes fixed purposes only, never an arbitrary signer.
 app.use('/api/jobs/*',async(c,next)=>{
  if(process.env.SERVICE_ROLE!=='operator'||!enabled())return c.json({error:'jobs_custody_disabled'},403);
  if(c.req.method!=='POST'||!jobsRoute(c.req.path))return c.json({error:'jobs_custody_route_denied'},403);
  if(!authorized(c.req.header('authorization'),secret()))return c.json({error:'unauthorized'},401);
  return next();
 });
 app.post('/api/jobs/wallet',async c=>{
  try{const raw=await c.req.text();if(Buffer.byteLength(raw)>32000)return c.json({error:'request_too_large'},413);return c.json(await wallet.tool(JSON.parse(raw)));}
  catch{return c.json({error:'jobs_custody_unavailable',outcome:'unknown',next:'Read the original action status; do not replace it.'},503);}
 });
 app.post('/api/jobs/session',async c=>{
  try{const raw=await c.req.text();if(raw.length>128)return c.json({error:'invalid_input'},400);const body=JSON.parse(raw);if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>k!=='rejectedSession')||('rejectedSession' in body&&(typeof body.rejectedSession!=='string'||!/^[a-f0-9]{64}$/.test(body.rejectedSession))))return c.json({error:'invalid_input'},400);const r=await session(body);return c.json({token:r.token,expiresAt:r.expiresAt});}
  catch{return c.json({error:'network_identity_unavailable'},503);}
 });
}
