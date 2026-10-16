import {Pool,neon,neonConfig} from '@neondatabase/serverless';
import {createPublicClient,http} from 'viem';
import {base} from 'viem/chains';
import {privateKeyToAccount} from 'viem/accounts';
import {authorized} from '../compute-funding/service.mjs';
import {investmentStore} from './store.mjs';
import {investmentService} from './service.mjs';
import {refreshCapitalCash} from './budget.js';
import {check} from './policy.mjs';
neonConfig.webSocketConstructor=WebSocket;
export function installCapitalRoutes(app,{env=process.env,request=fetch}={}){
 let instance,store;
 function load(){
  if(instance)return instance;
  const pool=new Pool({connectionString:env.PAYMENT_DATABASE_URL,max:2});pool.on('error',()=>{});store=investmentStore(pool);
  instance=investmentService({store,client:createPublicClient({chain:base,transport:http(env.BASE_RPC_URL??'https://mainnet.base.org',{timeout:12000,retryCount:0})}),account:()=>privateKeyToAccount(env.SIGNER_PRIVATE_KEY),
   enabled:()=>env.CAPITAL_EXECUTION_ENABLED==='true',refreshCash:()=>refreshCapitalCash(neon(env.PAYMENT_DATABASE_URL)),
   review:async input=>{const r=await request('https://claus-inference.vercel.app/api/capital',{method:'POST',redirect:'error',headers:{authorization:'Bearer '+env.CAPITAL_EXECUTION_SECRET,'content-type':'application/json'},body:JSON.stringify({operation:'review',input}),signal:AbortSignal.timeout(45000)});
    const raw=await r.text();check(raw.length<2000000,'review_response_size');const result=JSON.parse(raw);check(r.ok,'review_unavailable');return result;}});return instance;
 }
 app.post('/api/capital',async c=>{
  if(!authorized(c.req.header('authorization'),env.CAPITAL_EXECUTION_SECRET))return c.json({error:'unauthorized'},401);
  try{const raw=await c.req.text();if(Buffer.byteLength(raw)>40000)return c.json({error:'request_too_large'},413);
   const b=JSON.parse(raw);if(!b||Object.keys(b).sort().join(',')!=='input,operation'||!['admission','overview','prepare','advance','status'].includes(b.operation))return c.json({error:'capital_invalid_operation'},400);
   const service=load();if(b.operation==='admission')return c.json({active:env.CAPITAL_EXECUTION_ENABLED==='true'&&await store.active()});
   return c.json(await service[b.operation](b.input));
  }catch(e){return c.json({error:/^capital_[a-z_]+$/.test(e?.message)?e.message:'capital_service_unavailable',outcome:'inspect_original'},409);}
 });
}
