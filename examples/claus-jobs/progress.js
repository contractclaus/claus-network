const labels={open:'Open',claimed:'Claimed',submitted:'Delivery submitted',accepted:'Work accepted',cancelled:'Cancelled',unfunded:'Awaiting funding',funded:'Funded',working:'In progress',disputed:'Disputed',credited:'Payment credited',refunded:'Refund credited',split:'Split credits',payment_unknown:'Payment unavailable'};
const el=(tag,text)=>{const n=document.createElement(tag);if(text)n.textContent=text;return n;};
let active;
export function showProgress(task,host,{api,projectId}){
 active?.abort();const section=el('section');section.className='delivery-result';
 const title=el('h3','Progress'),status=el('p','Loading progress…'),next=el('div'),refresh=el('button','Refresh progress');
 status.setAttribute('role','status');refresh.type='button';refresh.className='quiet';
 section.append(title,status,next,refresh);host.append(section);
 async function read(){
  active?.abort();const request=new AbortController();active=request;const timeout=setTimeout(()=>request.abort(),15000);
  section.setAttribute('aria-busy','true');refresh.disabled=true;
  try{
   const r=await fetch(api+'/v1/public/apps/'+encodeURIComponent(projectId)+'/tasks/'+encodeURIComponent(task.id)+'/progress',{credentials:'omit',cache:'no-store',signal:request.signal});
   if(!r.ok)throw Error();const data=await r.json();if(active!==request||!section.isConnected)return;
   if(data.profile!=='claus-task-progress/1'||data.taskId!==task.id||data.projectId!==projectId||!Array.isArray(data.next))throw Error();
   status.textContent=labels[data.phase]||'State unavailable';next.replaceChildren();
   for(const step of data.next){const p=el('p',({requester:'Requester',worker:'Worker',party:'Agreement parties',any:'Next'}[step.actor]||'Next')+': '+step.label);next.append(p);}
   if(['credited','refunded','split'].includes(data.phase))next.append(el('p','Credit is available in escrow. Check the balance to withdraw.'));
   if(data.phase==='payment_unknown')next.append(el('p','The payment could not be checked. No transaction was sent.'));
  }catch{if(active===request&&section.isConnected){status.textContent='Progress could not load';next.replaceChildren();}}
  finally{clearTimeout(timeout);if(active===request){refresh.disabled=false;section.setAttribute('aria-busy','false');}}
 }
 refresh.onclick=()=>void read();void read();
}
