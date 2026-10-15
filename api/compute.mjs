import {timingSafeEqual} from 'node:crypto';
import {application} from './gateway.mjs';
export default async function handler(req,res){
 res.setHeader('cache-control','no-store');const secret=process.env.CRON_SECRET,supplied=req.headers.authorization;
 if(req.method!=='GET'||!secret||typeof supplied!=='string'||Buffer.byteLength(supplied)!==Buffer.byteLength('Bearer '+secret)||!timingSafeEqual(Buffer.from(supplied),Buffer.from('Bearer '+secret))){res.status(401).json({error:'unauthenticated'});return;}
 try{
  const {app,store}=await application(),at=Date.now(),state=await app.inference.discovery();
  await app.runtimes.tick();
  if(!state.enabled){res.status(200).json({enabled:false});return;}
  const results=await Promise.allSettled([app.inference.run(),app.inference.run()]);
  await store.transaction(async tx=>{const old=await tx.read('worker-health','inference');await tx.write('worker-health','inference',{observedAt:Date.now(),durationMs:Date.now()-at,release:process.env.CLAUS_NETWORK_RELEASE,completedWorkers:results.filter(r=>r.status==='fulfilled').length,failedWorkers:results.filter(r=>r.status==='rejected').length},old?.revision??0);});
  res.status(results.some(r=>r.status==='rejected')?503:200).json({ok:results.every(r=>r.status==='fulfilled')});
 }catch{res.status(503).json({error:'inference_worker_unavailable'});}
}
