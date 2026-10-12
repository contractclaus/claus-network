import {timingSafeEqual} from 'node:crypto';
import {createCollaborationWorker} from '../runtime/collaboration-worker.mjs';
let worker;
export default async function handler(req,res){
  const supplied=Buffer.from(req.headers.authorization??''),expected=Buffer.from('Bearer '+(process.env.CRON_SECRET??''));
  if(!process.env.CRON_SECRET||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){
    res.status(401).json({error:'unauthenticated'});return;
  }
  if(req.method!=='GET'){res.status(405).end();return;}
  try{
    worker??=createCollaborationWorker(process.env.CLAUS_COLLABORATION_ROLE).catch(error=>{worker=null;throw error;});
    res.status(200).json(await(await worker).tick());
  }catch{res.status(503).json({error:'worker_unavailable'});}
}
