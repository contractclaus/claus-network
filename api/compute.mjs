import {hostContinuity} from '../src/continuity-host.mjs';
import {computeCycle} from '../runtime/compute-cycle.mjs';
import {timingSafeEqual} from 'node:crypto';
import {application} from './gateway.mjs';
export default async function handler(req,res){
 res.setHeader('cache-control','no-store');const secret=process.env.CRON_SECRET,supplied=req.headers.authorization;
 if(req.method!=='GET'||!secret||typeof supplied!=='string'||Buffer.byteLength(supplied)!==Buffer.byteLength('Bearer '+secret)||!timingSafeEqual(Buffer.from(supplied),Buffer.from('Bearer '+secret))){res.status(401).json({error:'unauthenticated'});return;}
 try{
  const {app,store}=await application();
  const result=await hostContinuity('worker:compute',null,{},()=>computeCycle({app,store,release:process.env.CLAUS_NETWORK_RELEASE??null}));
  res.status(result.ok?200:503).json(result);
 }catch{res.status(503).json({error:'inference_worker_unavailable'});}
}
