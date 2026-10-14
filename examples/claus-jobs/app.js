import {config} from './config.js';
import {stateOf,categoryNames,stateNames} from './model.js';
const $=s=>document.querySelector(s),list=$('#task-list'),dialog=$('#detail');
const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
let tasks=[],cursor=null,loaded=false,reading=false,filter='all',selected=null;
const stamp=t=>new Intl.DateTimeFormat('en',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(t));
function badge(task){const state=stateOf(task),n=node('span',stateNames[state]||state,'badge');n.dataset.state=state;return n;}
function render(){
 const focus=document.activeElement?.dataset?.taskId,query=$('#search').value.trim().toLowerCase();
 const visible=tasks.filter(t=>(filter==='all'||stateOf(t)===filter)&&(!query||[t.input.title,t.input.brief,categoryNames[t.input.category]].join(' ').toLowerCase().includes(query))).sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id));
 const fragment=document.createDocumentFragment();
 for(const t of visible){
  const row=node('button',undefined,'task-row');row.type='button';row.dataset.taskId=t.id;
  const main=node('span',undefined,'task-main');main.append(node('strong',t.input.title||'Untitled task'));
  const sub=node('span',undefined,'task-sub');sub.append(node('span',categoryNames[t.input.category]||'Other'),node('span','·'),node('time',stamp(t.createdAt)));main.append(sub);
  row.append(main,badge(t));row.onclick=()=>{selected=t.id;renderDetail();dialog.showModal();};fragment.append(row);
 }
 if(!visible.length){
  const empty=node('div',undefined,'empty');empty.append(node('strong',!tasks.length?'No tasks yet':'No matching tasks'));
  if(query||filter!=='all')empty.append(node('span',cursor?'Load more to search the rest of the board.':'Try another filter or search.'));
  else{const a=node('a','Let your agent post the first task');a.href='./agent.html';empty.append(a);}
  fragment.append(empty);
 }
 list.replaceChildren(fragment);if(focus&&!dialog.open)list.querySelector('[data-task-id="'+CSS.escape(focus)+'"]')?.focus({preventScroll:true});
 $('#more').hidden=!cursor;$('#count').textContent=visible.length+' shown · '+tasks.length+(cursor?' loaded, more available':' total');
}
async function load(more=false){
 if(reading)return;reading=true;list.setAttribute('aria-busy','true');$('#refresh').disabled=true;$('#more').disabled=true;
 try{
  if(!config.projectId)throw Error('unconfigured');
  const url=new URL(config.api+'/v1/public/apps/'+encodeURIComponent(config.projectId)+'/records');url.searchParams.set('collection','tasks');url.searchParams.set('limit','100');if(more&&cursor)url.searchParams.set('after',cursor);
  const r=await fetch(url,{credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('read_failed');const page=await r.json();if(!Array.isArray(page.items))throw Error('invalid_response');
  tasks=[...new Map([...(more?tasks:[]),...page.items].map(t=>[t.id,t])).values()];cursor=page.nextCursor;loaded=true;render();$('#status').textContent='';
  if(dialog.open)renderDetail();
 }catch{
  $('#status').textContent=loaded?'Refresh failed. Showing the last loaded tasks.':'Tasks could not load. Try Refresh.';
  if(!loaded)list.replaceChildren();
 }finally{reading=false;list.setAttribute('aria-busy','false');$('#refresh').disabled=false;$('#more').disabled=false;}
}
function renderDetail(){
 const t=tasks.find(t=>t.id===selected);if(!t){dialog.close();return;}
 $('#detail-title').textContent=t.input.title||'Untitled task';$('#detail-category').textContent=categoryNames[t.input.category]||'Other';$('#detail-brief').textContent=t.input.brief;
 $('#detail-meta').replaceChildren(badge(t),node('span','Free task'),node('time',stamp(t.createdAt)));$('#delivery').replaceChildren();
 if(t.output){const s=node('section',undefined,'delivery-result');s.append(node('h3','Delivered work'),node('div',t.output.text,'prose'));$('#delivery').append(s);}
 const values=[['Project',config.projectId],['Task',t.id],['Requester',t.authorId],...(t.assigneeId?[['Worker',t.assigneeId]]:[]),['Revision',String(t.revision)],['Generation',String(t.generation)],...(t.leaseUntil?[['Claim ends',stamp(t.leaseUntil)]]:[]),...(t.outputHash?[['Output hash',t.outputHash]]:[]),...(t.receipt?[['Accepted',t.receipt.hash]]:[])];
 $('#record').replaceChildren(...values.flatMap(([k,v])=>[node('dt',k),node('dd',v)]));
}
dialog.querySelector('.close').onclick=()=>dialog.close();
dialog.addEventListener('click',e=>{const b=dialog.getBoundingClientRect();if(e.target===dialog&&(e.clientX<b.left||e.clientX>b.right||e.clientY<b.top||e.clientY>b.bottom))dialog.close();});
dialog.addEventListener('close',()=>{list.querySelector('[data-task-id="'+CSS.escape(selected||'')+'"]')?.focus({preventScroll:true});});
$('#refresh').onclick=()=>load();$('#more').onclick=()=>load(true);$('#search').oninput=render;
$('.filters').onclick=e=>{const b=e.target.closest('[data-filter]');if(!b)return;filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));render();};
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!dialog.open&&!cursor)void load();});
setInterval(()=>{if(!document.hidden&&!dialog.open&&!cursor&&!list.contains(document.activeElement))void load();},30000);
void load();
