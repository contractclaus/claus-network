export function createClubTelegramUI({state,api,el}){
 const box=document.getElementById('telegram-club'),content=document.getElementById('telegram-actions'),status=document.getElementById('telegram-status');
 // A cached pre-Telegram document can load the current shared script.
 if(!box||!content||!status)return {sync(){}};
 let wallet=null,timer=null,version=0,last=null,busy=false;
 const error=e=>{status.textContent=e.message??'Please try again.';};
 const link=(text,url)=>el('a',{class:'solid telegram-link',href:url,target:'_blank',rel:'noopener noreferrer',text});
 async function action(fn){if(busy)return;busy=true;for(const b of content.querySelectorAll('button'))b.disabled=true;try{await fn();}catch(e){error(e);}finally{busy=false;for(const b of content.querySelectorAll('button'))b.disabled=false;}}
 function render(data){
  last=data;content.replaceChildren();document.body.classList.toggle('telegram-club-ready',data.enabled===true);
  box.hidden=data.enabled!==true;
  if(data.enabled!==true){status.textContent='';return;}
  const p=data.pending,m=data.member;
  if(p?.user_id){
   status.textContent='Telegram account: '+(p.first_name||'Member')+(p.username?' (@'+p.username+')':'')+' · ID '+p.user_id+'. Confirm only if this is you.';
   content.append(el('button',{type:'button',class:'solid',text:'Confirm my Telegram account',onclick:()=>action(async()=>{render(await api('telegram_confirm',{id:p.id,userId:p.user_id}));})}));return;
  }
  if(m&&['verified','joined'].includes(m.state)){
   status.textContent='Connected: '+(m.first_name||'Member')+(m.username?' (@'+m.username+')':'')+'. Your held and staked NFTs both count.';
   content.append(el('button',{type:'button',class:'solid',text:'Open Telegram group',onclick:()=>action(async()=>{const r=await api('telegram_invite',{requestId:crypto.randomUUID()});content.replaceChildren(link('Join Claus Club',r.url));status.textContent='This invitation is for your linked Telegram account and expires in 10 minutes. Tap Join, then request access in Telegram.';})}),el('button',{type:'button',class:'quiet',text:'Disconnect Telegram',onclick:()=>action(async()=>{await api('telegram_unlink',{});await refresh();})}));return;
  }
  status.textContent='Connect Telegram, confirm your account here, then get your private invitation. If you also link X, Claus can recognise you across both channels. Private Club messages stay private.';
  content.append(el('button',{type:'button',class:'solid',text:'Connect Telegram',onclick:()=>action(async()=>{const p=await api('telegram_pair',{});content.replaceChildren(link('Open @contractclausbot',p.url));status.textContent='Open the bot and tap Start. Then return here to confirm your Telegram account.';watch();})}));
 }
 async function refresh(){const v=version;if(!state.viewer||state.viewer.address!==wallet)return;try{const data=await api('telegram_status');if(v===version){box.hidden=false;render(data);if(data.pending&&!data.pending.user_id)watch();}}catch(e){if(v===version){box.hidden=false;error(e);}}}
 function watch(){clearTimeout(timer);timer=setTimeout(async()=>{if(!wallet)return;if(document.hidden){watch();return;}const v=version;try{const data=await api('telegram_status');if(v!==version)return;if(data.pending?.user_id||data.member&&['verified','joined'].includes(data.member.state))render(data);else if(data.pending)watch();else render(data);}catch(e){if(v===version)error(e);}},4000);}
 function sync(){const next=state.viewer?.address??null;if(next===wallet)return;version++;wallet=next;clearTimeout(timer);last=null;content.replaceChildren();box.hidden=!next;if(next){status.textContent='Checking Telegram access…';void refresh();}else document.body.classList.remove('telegram-club-ready');}
 document.addEventListener('visibilitychange',()=>{if(!document.hidden&&wallet){if(last?.pending)watch();else void refresh();}});
 return {sync};
}
