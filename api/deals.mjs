import {timingSafeEqual}from'node:crypto';
import {createPublicClient,http}from'viem';
import {privateKeyToAccount}from'viem/accounts';
import {Pool,neonConfig}from'@neondatabase/serverless';
import ws from'ws';
import {openPostgresStore}from'../src/postgres/index.mjs';
import {createAccess}from'../src/access/index.mjs';
import {createIdentity}from'../src/identity/index.mjs';
import {createArbitration}from'../src/deals/arbitration.mjs';
import {createSealer}from'../adapters/secrets.mjs';
import {dealPorts}from'../runtime/deal-ports.mjs';
import {arbitrationPorts}from'../runtime/arbitration-ports.mjs';
neonConfig.webSocketConstructor=ws;let loaded;
export default async function handler(req,res){
 res.setHeader('cache-control','no-store');const secret=process.env.CRON_SECRET,supplied=req.headers.authorization;
 if(req.method!=='GET'||!secret||typeof supplied!=='string'||Buffer.byteLength(supplied)!==Buffer.byteLength('Bearer '+secret)||!timingSafeEqual(Buffer.from(supplied),Buffer.from('Bearer '+secret))){res.status(401).json({error:'unauthenticated'});return;}
 try{
  loaded??=openPostgresStore({pool:new Pool({connectionString:process.env.CLAUS_NETWORK_DATABASE_URL,max:3,connectionTimeoutMillis:8000})}).catch(e=>{loaded=null;throw e;});
  const store=await loaded;const enabled=process.env.CLAUS_DEAL_ARBITRATION_ENABLED==='1';if(!enabled){await store.transaction(async tx=>{const old=await tx.read('worker-health','deals');await tx.write('worker-health','deals',{observedAt:Date.now(),enabled:false,release:process.env.CLAUS_NETWORK_RELEASE},old?.revision??0);});res.status(200).json({ok:true,enabled:false,processed:0});return;}let access;const identity=createIdentity({store,writesEnabled:async reader=>!(await access.policy(reader)).config.paused});access=createAccess({store,identity});
  const chain=dealPorts(),ports=arbitrationPorts({store,sealer:createSealer(process.env.CLAUS_DEAL_SEALING_KEY),paymentSigner:privateKeyToAccount(process.env.CLAUS_DEAL_PAYMENT_KEY),arbiterSigner:privateKeyToAccount(process.env.CLAUS_DEAL_ARBITER_KEY),mainnetClient:createPublicClient({transport:http(process.env.CLAUS_MAINNET_RPC_URL,{retryCount:0,timeout:10000})}),dealPorts:chain,pins:JSON.parse(process.env.CLAUS_DEAL_PINS??'[]'),nativeOrigin:process.env.CLAUS_NATIVE_URL,nativeSecret:process.env.CLAUS_NETWORK_REVIEW_SECRET}),deals=createArbitration({store,identity,dealPorts:chain,ports,enabled:process.env.CLAUS_DEAL_ARBITRATION_ENABLED==='1'}),start=Date.now();
  const pins=JSON.parse(process.env.CLAUS_DEAL_PINS??'[]');if(pins.length===0)throw Error('deal_pins_missing');const targets=[];for(const pin of pins){const c=await chain.context(pin.chainId,{fresh:true});targets.push({chainId:pin.chainId,contract:c.public.contract,codeHash:c.public.codeHash});}
  await ports.reconcile();const result=await deals.tick();await store.transaction(async tx=>{const old=await tx.read('worker-health','deals');await tx.write('worker-health','deals',{observedAt:Date.now(),enabled:true,targets,durationMs:Date.now()-start,processed:result.processed,release:process.env.CLAUS_NETWORK_RELEASE},old?.revision??0);});res.status(200).json({ok:true,...result});
 }catch{res.status(503).json({error:'deal_worker_unavailable'});}
}
