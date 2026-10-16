import {isHomeProject} from '../network/map-groups.js';
const ORIGIN='https://claus-network-api.vercel.app';
const kinds=new Set(['project.updated','project.published','interface.created','task.posted','task.claim','task.deliver','task.accept','task.cancel','task.agreement']);
let pending;
export async function collectActivity({readRequest,now=Date.now}={}) {
  const data=readRequest?await readRequest('/v1/public/activity?limit=100'):await (async()=>{
    const response=await fetch(ORIGIN+'/v1/public/activity?limit=100',{signal:AbortSignal.timeout(5000),redirect:'error'});
    if(!response.ok)throw Error('unavailable');
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>100000){await reader.cancel();throw Error('too_large');}chunks.push(value);}}finally{reader.releaseLock();}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  })();
  if(!Array.isArray(data.events)||!Number.isFinite(data.observedAt))throw Error('invalid_activity');
  return {observedAt:data.observedAt,complete:true,historyComplete:false,coverage:data.coverage,events:data.events.filter(e=>
    isHomeProject(e.projectId)&&typeof e.id==='string'&&e.id.length<=200&&typeof e.project==='string'&&e.project.length<=80&&
    /^\/c\/[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(e.href)&&kinds.has(e.kind)&&
    Number.isFinite(e.at)&&e.at>0&&e.at<=now()+60000&&(!e.taskId||/^[A-Za-z0-9:_-]{1,120}$/.test(e.taskId))
  ).slice(0,40).map(({id,projectId,project,href,kind,at,taskId})=>({id,projectId,project,href,kind,at,...(taskId?{taskId}:{})}))};
}
export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  if(!['GET','HEAD'].includes(req.method)){res.status(405).end();return;}
  if(new URL(req.url,'https://claus.si').search){res.status(400).json({error:'invalid_request'});return;}
  try {
    if(!pending)pending=collectActivity().finally(()=>{pending=null;});
    const data=await pending;
    res.setHeader('Cache-Control','public, max-age=0, s-maxage=5, must-revalidate');
    res.status(200).json(data);
  }catch{res.status(503).json({error:'network_activity_unavailable'});}
}
