import {isHomeProject} from '../network/map-groups.js';
// This projection reads only the same public records exposed by the explorer.
const ORIGIN='https://claus-network-api.vercel.app';
const slugPattern=/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;
const date=value=>typeof value==='number'?value:Date.parse(value);
export function projectEvents(p,now=Date.now()){
  if(!isHomeProject(p?.projectId)||p?.published!==true||!slugPattern.test(p.slug)||typeof p.name!=='string'||p.name.length>80)return [];
  const events=[];
  function add(id,kind,at,extra={}){at=date(at);if(Number.isFinite(at)&&at>0&&at<=now+60000)events.push({id:p.projectId+':'+id,projectId:p.projectId,project:p.name,href:'/c/'+p.slug,kind,at,...extra});}
  add('publication:'+p.revision,p.revision===1?'project.published':'project.updated',p.updatedAt);
  for(const r of p.releases??[])if(r.expiresAt===null||r.expiresAt>now)add('release:'+r.id,'interface.created',r.createdAt);
  for(const d of p.evidence?.decisions??[]){
    if(!['Approved','Rejected'].includes(d.status))continue;
    const execution=(p.evidence?.deployments??[]).find(e=>e.id===d.id);
    const hosts={1:'etherscan.io',11155111:'sepolia.etherscan.io'};
    const tx=execution&&hosts[execution.chainId]&&/^0x[0-9a-f]{64}$/i.test(execution.transactionHash)?'https://'+hosts[execution.chainId]+'/tx/'+execution.transactionHash:null;
    add('decision:'+d.id,d.status==='Approved'?'update.approved':'update.rejected',d.completedAt,tx?{transaction:tx,chain:execution.chainId===1?'Ethereum':'Sepolia'}:{});
  }
  for(const r of p.results??[])if(r.projectId===p.projectId&&r.dataPolicy==='public-data-v1'&&(!r.expiresAt||r.expiresAt>now)){
    const readable=r.progress?.phase==='accepted'&&/^sha256:[0-9a-f]{64}$/.test(r.id??'');
    add('result:'+r.id,'result.published',r.publishedAt,readable?{receipt:'/read/work/'+r.id,provider:String(r.parties?.provider?.name??'').slice(0,80)}:{});
  }
  return events;
}
async function read(path,signal){
  const r=await fetch(ORIGIN+path,{signal,redirect:'error'});if(!r.ok)throw Error('unavailable');
  const reader=r.body.getReader(),chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1048576){await reader.cancel();throw Error('too_large');}chunks.push(value);}}finally{reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
let pending,detailCursor=0;
const recentDetails=new Map();
export async function collectActivity({readRequest=read,now=Date.now,deadlineMs=3500,cache=recentDetails}={}){
 const controller=new AbortController(),signal=controller.signal,timer=setTimeout(()=>controller.abort(),deadlineMs);
 const stopped=new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
 try{
  const nodes=[],cursors=new Set();let after='',complete=true;
  for(let page=0;page<100&&!signal.aborted;page++){
   let g;try{g=await readRequest('/v1/public/graph?limit=100&view=projects'+(after?'&after='+encodeURIComponent(after):''),signal);}catch(error){if(!nodes.length)throw error;complete=false;break;}
   if(g.schemaVersion!=='1.0'||!Array.isArray(g.nodes))throw Error('invalid_graph');
   nodes.push(...g.nodes);after=g.nextCursor??'';if(!after)break;
   if(cursors.has(after))throw Error('repeated_cursor');cursors.add(after);if(page===99)complete=false;
  }
  const projects=[...new Map(nodes.filter(n=>n.kind==='project'&&slugPattern.test(n.slug)&&isHomeProject(n.id)).map(n=>[n.id,n])).values()];
  const currentIds=new Set(projects.map(p=>p.id)),events=projects.flatMap(p=>projectEvents({...p,projectId:p.id,name:p.label,published:true},now()));
  for(const [id,value]of cache)if(!currentIds.has(id)||now()-value.at>28000)cache.delete(id);
  const start=projects.length?detailCursor%projects.length:0,ordered=projects.slice(start).concat(projects.slice(0,start));
  let cursor=0,succeeded=0;
  const readers=Array.from({length:Math.min(6,ordered.length)},async()=>{
   while(!signal.aborted){const p=ordered[cursor++];if(!p)return;
    try{
     const record=await readRequest('/v1/public/projects/'+p.slug,signal);if(signal.aborted)return;if(record.projectId!==p.id)throw Error('mismatch');
     const detail=projectEvents(record,now());
     if(record.application?.manifest?.tasks?.visibility==='public'){
      const activity=await readRequest('/v1/public/apps/'+encodeURIComponent(p.id)+'/activity?limit=40',signal);if(signal.aborted)return;
      for(const e of activity.items??[])if(e.projectId===p.id&&['task.posted','task.claim','task.deliver','task.accept','task.cancel','task.agreement'].includes(e.type)&&/^[A-Za-z0-9:_-]{1,120}$/.test(e.taskId??'')&&Number.isFinite(e.at)&&e.at>0&&e.at<=now()+60000)detail.push({id:e.id,projectId:p.id,project:record.name,href:'/c/'+p.slug,kind:e.type,at:e.at,taskId:e.taskId});
     }
     if(!signal.aborted){cache.set(p.id,{at:now(),events:detail});succeeded++;}
    }catch{complete=false;}
   }
  });
  await Promise.race([Promise.allSettled(readers),stopped]);
  detailCursor=start+Math.min(cursor,ordered.length);
  for(const p of projects){const value=cache.get(p.id);if(value&&now()-value.at<=28000)events.push(...value.events);}
  return {observedAt:now(),complete:complete&&!after&&!signal.aborted&&succeeded===projects.length,scanned:succeeded,
   registryProjects:projects.length,coverage:'Fresh registry events plus bounded public detail observations.',
   events:[...new Map(events.map(e=>[e.id,e])).values()].sort((a,b)=>b.at-a.at).slice(0,40)};
 }finally{controller.abort();clearTimeout(timer);}
}
export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  if(!['GET','HEAD'].includes(req.method)){res.status(405).end();return;}
  if(new URL(req.url,'https://claus.si').search){res.status(400).json({error:'invalid_request'});return;}
  try{
    // Coalesce concurrent reads; CDN caching provides the cross-instance cache.
    if(!pending)pending=collectActivity({}).finally(()=>{pending=null;});
    const data=await pending;
    res.setHeader('Cache-Control','public, max-age=0, s-maxage=8, stale-while-revalidate=20');res.status(200).json(data);
  }catch{res.status(503).json({error:'network_activity_unavailable'});}
}
