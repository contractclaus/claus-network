import {hostContinuity} from '../src/continuity-host.mjs';
import {timingSafeEqual} from 'node:crypto';
import {application} from './gateway.mjs';
export default async function handler(req,res){
  res.setHeader('cache-control','no-store');const secret=process.env.CRON_SECRET,supplied=req.headers.authorization;
  if(req.method!=='GET'||!secret||typeof supplied!=='string'||Buffer.byteLength(supplied)!==Buffer.byteLength('Bearer '+secret)||!timingSafeEqual(Buffer.from(supplied),Buffer.from('Bearer '+secret))){res.status(401).json({error:'unauthenticated'});return;}
  try{const outcome=await hostContinuity('worker:workflows',null,{},async()=>{const {app,store}=await application(),start=Date.now(),result=await app.workflows.tick();await app.webhooks.tick();
    await store.transaction(async tx=>{const old=await tx.read('worker-health','workflows');await tx.write('worker-health','workflows',{observedAt:Date.now(),release:process.env.CLAUS_NETWORK_RELEASE,processed:result.processed,durationMs:Date.now()-start,retryCount:result.results.filter(r=>r.state==='retry').length,profile:'recurring-public-free-tasks-v1'},old?.revision??0);});
    return {ok:true,processed:result.processed};});res.status(200).json(outcome);
  }catch{res.status(503).json({error:'worker_unavailable'});}
}
