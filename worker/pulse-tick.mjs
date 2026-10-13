import {timingSafeEqual} from 'node:crypto';
import {createPulseHost} from '../runtime/pulse-host.mjs';
let worker;
export default async function handler(req,res){
 res.setHeader('cache-control','no-store');
 const expected=Buffer.from('Bearer '+(process.env.CRON_SECRET??'')),actual=Buffer.from(req.headers.authorization??'');
 if(!process.env.CRON_SECRET||actual.length!==expected.length||!timingSafeEqual(actual,expected)){
  res.status(401).json({error:'unauthorized'});return;
 }
 if(req.method!=='GET'){res.status(405).json({error:'method_not_allowed'});return;}
 try{worker??=createPulseHost();res.status(200).json(await (await worker).tick());}
 catch{worker=null;res.status(503).json({error:'reference_worker_unavailable'});}
}
