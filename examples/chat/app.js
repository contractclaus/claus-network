import {app,status,message,node,run,requireSession} from './shared.js';
const list=document.querySelector('#messages'),input=document.querySelector('#message'),send=document.querySelector('#send'),more=document.querySelector('#more');
let after=null,pending=null;
async function load(reset=true){const page=await app.call('public_app_records',{collection:'messages',limit:50,...(!reset&&after?{after}:{})});if(reset)list.replaceChildren();for(const row of page.items){const item=node('article','');item.append(node('p',row.data.text),node('small',row.authorId.slice(0,14)+' · '+new Date(row.createdAt).toLocaleString()));list.append(item);}after=page.nextCursor;more.hidden=!after;}
send.onclick=()=>run(send,async()=>{await requireSession();const text=input.value.trim();if(!text)return;if(pending&&pending.text!==text)throw Error('Resolve the previous message before changing it');pending??={text,key:crypto.randomUUID()};await app.call('app_record_create',{collection:'messages',data:{text},idempotencyKey:pending.key});pending=null;input.value='';await load();status.textContent='Sent';});
more.onclick=()=>run(more,()=>load(false));
load().catch(message);setInterval(()=>{if(!document.hidden&&!after)load().catch(message);},10000);
