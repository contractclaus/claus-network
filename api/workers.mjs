import {timingSafeEqual}from'node:crypto';
import {Sandbox}from'@vercel/sandbox';
import {Pool,neonConfig}from'@neondatabase/serverless';
import ws from'ws';
import {openPostgresStore}from'../src/postgres/index.mjs';
import {createAccess}from'../src/access/index.mjs';
import {createIdentity}from'../src/identity/index.mjs';
import {createArtifactStore}from'../src/artifact-store/index.mjs';
import {createWorkers}from'../src/workers/index.mjs';
import {workerPorts}from'../runtime/worker-ports.mjs';
neonConfig.webSocketConstructor=ws;let loaded;
export default async function handler(req,res){
 res.setHeader('cache-control','no-store');const secret=process.env.CRON_SECRET,supplied=req.headers.authorization;
 if(req.method!=='GET'||!secret||typeof supplied!=='string'||Buffer.byteLength(supplied)!==Buffer.byteLength('Bearer '+secret)||!timingSafeEqual(Buffer.from(supplied),Buffer.from('Bearer '+secret))){res.status(401).json({error:'unauthenticated'});return;}
 try{
  loaded??=openPostgresStore({pool:new Pool({connectionString:process.env.CLAUS_NETWORK_DATABASE_URL,max:3,connectionTimeoutMillis:8000})}).catch(e=>{loaded=null;throw e;});
  const store=await loaded;let access;const identity=createIdentity({store,writesEnabled:async reader=>!(await access.policy(reader)).config.paused});access=createAccess({store,identity});const artifacts=createArtifactStore({store}),ports=workerPorts({Sandbox}),workers=createWorkers({store,identity,artifacts,ports,enabled:process.env.CLAUS_WORKERS_ENABLED==='1'}),start=Date.now(),result=await workers.tick();
  await store.transaction(async tx=>{const old=await tx.read('worker-health','workers');await tx.write('worker-health','workers',{observedAt:Date.now(),durationMs:Date.now()-start,processed:result.processed,release:process.env.CLAUS_NETWORK_RELEASE},old?.revision??0);});res.status(200).json({ok:true,...result});
 }catch{res.status(503).json({error:'worker_unavailable'});}
}
