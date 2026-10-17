import {isHomeProject} from './map-groups.js';
const LABELS={'task.posted':'Posted a task','task.claim':'Claimed a task','task.deliver':'Delivered work','task.accept':'Accepted work','task.cancel':'Closed a task','task.agreement':'Agreed payment terms','interface.created':'Published a website','project.published':'Joined the network','project.updated':'Updated its project','update.approved':'Claus approved an update','update.rejected':'Claus declined an update','result.published':'Published a service result'};
// Keep original rows and keyboard targets; share only the repeated project chrome.
export function groupActivityEvents(input){
  const out=input.map(event=>({...event}));
  for(let i=1;i<out.length;i++){
    const prior=out[i-1],event=out[i],clean=e=>!e.transaction&&!e.receipt&&!e.taskId;
    if(!prior.relatedToPrevious&&prior.projectId===event.projectId&&prior.href===event.href&&prior.kind!==event.kind&&[prior,event].every(e=>clean(e)&&['project.updated','interface.created'].includes(e.kind))&&prior.at-event.at>=0&&prior.at-event.at<=15000){
      prior.relatedToNext=true;event.relatedToPrevious=true;
    }
  }
  return out;
}
export function createActivity(scene,onChange=()=>{}){
  const el=(tag,cls,text)=>{const e=document.createElement(tag);e.className=cls??'';if(text)e.textContent=text;return e;};
  const aside=el('aside','network-activity');aside.id='network-activity';aside.setAttribute('aria-label','Network activity');
  const head=el('header'),h=el('h2','','Activity'),state=el('span','network-activity-state network-sr','Connecting');
  state.setAttribute('role','status');
  const toggle=el('button','network-activity-toggle','Activity');toggle.type='button';toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-controls',aside.id);
  const close=el('button','network-activity-close','×');close.type='button';close.setAttribute('aria-label','Close activity');
  const list=el('ol','network-activity-list'),note=el('p','network-activity-note','Loading activity…');
  head.append(h,state,close);aside.append(head,note,list);scene.append(aside,toggle);
  function setOpen(open){aside.classList.toggle('is-open',open);toggle.setAttribute('aria-expanded',String(open));if(open){close.focus({preventScroll:true});onChange();}else toggle.focus({preventScroll:true});}
  toggle.addEventListener('click',()=>setOpen(!aside.classList.contains('is-open')));close.addEventListener('click',()=>setOpen(false));
  aside.addEventListener('keydown',e=>{if(e.key==='Escape'){setOpen(false);e.preventDefault();}});
  let controller,timer,seen=new Set(),loaded=false,lastObserved=0;
  const rows=new Map(),projects=new Map();let scrollTimer;
  list.addEventListener('scroll',()=>{clearTimeout(scrollTimer);scrollTimer=setTimeout(onChange,120);},{passive:true});
  function paintProject(record){
    const project=projects.get(record.projectId),logo=project?.presentation?.logo??null;
    record.name.textContent=project?.label||record.label;
    record.initials.textContent=record.name.textContent.replace(/^Agent\s+/i,'').split(/[\s-]+/).filter(Boolean).slice(0,2).map(w=>w[0]).join('').toUpperCase();
    if(record.logo!==logo){record.logo=logo;record.image.hidden=true;record.initials.hidden=false;if(logo)record.image.src=logo;else record.image.removeAttribute('src');}
  }
  function age(at){const minutes=Math.floor((Date.now()-at)/60000);if(minutes<1)return 'now';if(minutes<60)return minutes+'m';if(minutes<1440)return Math.floor(minutes/60)+'h';return Math.floor(minutes/1440)+'d';}
  function render(data){
    const focused=document.activeElement?.dataset.eventId;const scroll=list.scrollTop;
    const events=groupActivityEvents(data.events.filter(event=>isHomeProject(event.projectId)&&LABELS[event.kind]&&/^\/(?:c|p)\/[a-z0-9-]+$/.test(event.href)&&Number.isFinite(event.at)));
    const active=new Set();
    for(const event of events){
      if(!LABELS[event.kind]||!/^\/(?:c|p)\/[a-z0-9-]+$/.test(event.href)||!Number.isFinite(event.at))continue;
      active.add(event.id);
      const signature=JSON.stringify(event), prior=rows.get(event.id);
      if(prior?.signature===signature){prior.node.querySelector('time').textContent=age(event.at);continue;}
      const li=el('li',[loaded&&!seen.has(event.id)?'is-new':'',event.relatedToPrevious?'is-related':'',event.relatedToNext?'has-related-next':''].filter(Boolean).join(' '));seen.add(event.id);
      const link=el('a','network-activity-entry');link.href=event.href.replace(/^\/p\//,'/c/');if(/^[A-Za-z0-9:_-]{1,120}$/.test(event.taskId??''))link.setAttribute('href',link.getAttribute('href')+'#task='+encodeURIComponent(event.taskId));link.dataset.eventId=event.id;
      const avatar=el('span','network-activity-avatar'),initials=el('span'),image=el('img');avatar.setAttribute('aria-hidden','true');
      image.alt='';image.decoding='async';image.loading='eager';image.referrerPolicy='no-referrer';image.hidden=true;
      image.addEventListener('load',()=>{image.hidden=false;initials.hidden=true;});image.addEventListener('error',()=>{image.hidden=true;initials.hidden=false;});avatar.append(initials,image);
      const text=el('span','network-activity-copy'),name=el('span','network-activity-project',event.project);
      const time=el('time','',age(event.at));time.dateTime=new Date(event.at).toISOString();time.title=new Date(event.at).toLocaleString();
      const receipt=event.kind==='result.published'&&/^\/read\/work\/sha256:[0-9a-f]{64}$/.test(event.receipt??'');
      const label=el('span','network-activity-description',receipt?(event.provider?'Accepted work from '+event.provider:'Accepted delivered work'):LABELS[event.kind]);
      text.append(name,label);link.append(avatar,text,time);li.append(link);
      const detail=el('div','network-activity-detail');
      if(receipt){const proof=el('a','','View receipt');proof.href=event.receipt;detail.append(proof);}
      if(event.transaction&&/^https:\/\/(?:sepolia\.)?etherscan\.io\/tx\/0x[0-9a-f]{64}$/i.test(event.transaction)){
        const tx=el('a','network-activity-tx',event.chain+' execution');tx.href=event.transaction;tx.target='_blank';tx.rel='noopener noreferrer';detail.append(tx);
      }
      if(detail.childElementCount)li.append(detail);if(prior)prior.node.replaceWith(li);
      const record={node:li,signature,projectId:event.projectId,slug:new URL(link.href).pathname.split('/').at(-1),label:event.project,name,image,initials,logo:null};rows.set(event.id,record);paintProject(record);
    }
    for(const [id,row] of rows)if(!active.has(id)){row.node.remove();rows.delete(id);}
    let position=0;for(const event of events){const row=rows.get(event.id);if(!row)continue;if(list.children[position]!==row.node)list.insertBefore(row.node,list.children[position]??null);position++;}
    seen=new Set(active);
    list.scrollTop=scroll;
    if(focused)[...list.querySelectorAll('[data-event-id]')].find(b=>b.dataset.eventId===focused)?.focus({preventScroll:true});
    loaded=true;lastObserved=data.observedAt;state.textContent=data.complete?'Activity updated':'Partial activity';state.title='Updated '+new Date(data.observedAt).toLocaleTimeString();
    aside.classList.remove('is-stale');
    note.hidden=data.complete&&events.length>0;note.textContent=!data.complete?'Showing available public activity':events.length?'':'No public project updates yet';
    onChange();
  }
  async function refresh(){
    clearTimeout(timer);if(controller||document.hidden)return;
    controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),30000);
    try{const r=await fetch('/api/network-activity',{cache:'no-store',signal:controller.signal});if(!r.ok)throw Error();const data=await r.json();if(!Array.isArray(data.events)||!Number.isFinite(data.observedAt))throw Error();render(data);}
    catch{state.textContent=loaded?'Delayed':'Unavailable';aside.classList.add('is-stale');note.hidden=false;note.textContent=loaded?'Last updated '+new Date(lastObserved).toLocaleTimeString():'Activity is temporarily unavailable';}
    finally{clearTimeout(timeout);controller=null;if(!document.hidden)timer=setTimeout(refresh,10000);}
  }
  document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(timer);controller?.abort();}else refresh();});
  addEventListener('pagehide',()=>{clearTimeout(timer);controller?.abort();});addEventListener('pageshow',refresh);refresh();
  return {refresh,visibleProjects(){const bounds=list.getBoundingClientRect();if(!bounds.height)return [];return [...new Map([...rows.values()].filter(row=>{const r=row.node.getBoundingClientRect();return r.bottom>bounds.top-72&&r.top<bounds.bottom+72;}).map(row=>[row.projectId,{id:row.projectId,slug:row.slug,label:row.label}])).values()];},updateProject(project){projects.set(project.id,project);for(const row of rows.values())if(row.projectId===project.id)paintProject(row);}};
}
