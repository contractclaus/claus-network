import {reconcileTelegramActivation} from './telegram-activation.mjs';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {ClubError,demand} from './club-common.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
const userId=v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0?String(v):null;
export const telegramSecretMatches=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length>20&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export const inviteMatches=(invite,member,request,now=Date.now())=>!!invite&&!!member&&invite.state==='live'&&new Date(invite.expires_at).getTime()>now&&invite.user_id===String(request.from?.id)&&member.user_id===invite.user_id&&member.address===invite.address&&['verified','joined'].includes(member.state)&&invite.invite_link===request.invite_link?.invite_link;
export function createTelegramClient(token=process.env.CLUB_TELEGRAM_BOT_TOKEN,request=fetch){
 return async(method,payload)=>{
  demand(!!token,503,'telegram_unavailable','Telegram is being connected.');
  let r,b;
  try{r=await request('https://api.telegram.org/bot'+token+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(12000)});b=await r.json();}
  catch{throw Object.assign(Error('telegram_delivery_unknown'),{uncertain:true});}
  if(!r.ok||!b.ok)throw Object.assign(Error('telegram_api_'+(b.error_code??r.status)),{status:b.error_code??r.status,retryAfter:b.parameters?.retry_after,description:String(b.description??'').slice(0,200)});
  return b.result;
 };
}
export function createClubTelegram({store,chain,call=createTelegramClient(),wake=async()=>{}}){
 const sql=store.sql;
 const config=async()=>{const [c]=await sql`SELECT * FROM club_telegram_config WHERE id`;demand(c?.enabled,503,'telegram_unavailable','Telegram is being connected. Please try again shortly.');return c;};
 async function queue(id,method,payload){await sql`INSERT INTO club_telegram_outbox(id,method,payload) VALUES(${id},${method},${JSON.stringify(payload)}::jsonb) ON CONFLICT DO NOTHING`;}
 async function deliver(id){
  const [row]=await sql`UPDATE club_telegram_outbox SET state='sending',lease_until=now()+interval '45 seconds',attempts=attempts+1 WHERE id=${id} AND state='pending' AND next_at<=now() RETURNING *`;
  if(!row)return (await sql`SELECT state,result FROM club_telegram_outbox WHERE id=${id}`)[0];
  let accepted=false;
  try{
   const result=await call(row.method,row.payload);
   accepted=true;
   if(row.method==='sendMessage'&&id.startsWith('club-message:')){
    await sql`WITH saved AS (UPDATE club_telegram_outbox SET state='done',result=${JSON.stringify(result)}::jsonb,completed_at=now(),lease_until=NULL WHERE id=${id} RETURNING id)
     INSERT INTO club_telegram_messages(chat_id,telegram_id,club_id,direction) SELECT ${String(result.chat.id)},${result.message_id},${id.slice(13)}::bigint,'out' FROM saved ON CONFLICT DO NOTHING`;
   }else await sql`UPDATE club_telegram_outbox SET state='done',result=${JSON.stringify(result)}::jsonb,completed_at=now(),lease_until=NULL WHERE id=${id}`;
   return {state:'done',result};
  }catch(e){
   const unsafe=['sendMessage','createChatInviteLink'].includes(row.method);
   const state=accepted||e.uncertain||unsafe&&e.status>=500?(unsafe?'uncertain':'pending'):e.status===429||e.status>=500?'pending':'failed';
   await sql`UPDATE club_telegram_outbox SET state=${state},error_code=${e.uncertain?'delivery_unknown':'telegram_'+(e.status??'storage_unknown')},next_at=now()+make_interval(secs=>${Math.max(10,Math.min(3600,Number(e.retryAfter)||30))}),lease_until=NULL WHERE id=${id}`;
   return {state};
  }
 }
 async function dm(id,to,text,buttons){await queue(id,'sendMessage',{chat_id:to,text,...(buttons?{reply_markup:{inline_keyboard:buttons}}:{}),link_preview_options:{is_disabled:true}});return deliver(id);}
 async function revoke(member,reason='nft_required'){
  const c=await config();await sql`UPDATE club_telegram_members SET state='revoked',updated_at=now(),next_check_at=now()+interval '1 day' WHERE user_id=${member.user_id}`;
  if(member.user_id!==c.owner_id){await queue('remove:'+member.user_id+':'+member.updated_at,'banChatMember',{chat_id:c.chat_id,user_id:Number(member.user_id),revoke_messages:false});await deliver('remove:'+member.user_id+':'+member.updated_at);}
  await dm('access-lost:'+member.user_id+':'+member.updated_at,member.user_id,reason==='disconnected'?'Your Telegram account is disconnected from Claus Club. Reconnect at https://claus.si/Club whenever you want to return.':'Your Claus Club access needs a new NFT check. Held and staked Claus NFTs both count. Reconnect at https://claus.si/Club.');
 }
 async function check(member,force=false){
  if(!member||!['verified','joined'].includes(member.state))return false;
  if(!force&&Date.now()-new Date(member.checked_at).getTime()<60000)return true;
  try{await chain.membership(member.address);}catch(e){if(e.code==='nft_required'){await revoke(member);return false;}throw e;}
  await sql`UPDATE club_telegram_members SET checked_at=now(),next_check_at=now()+interval '5 minutes' WHERE address=${member.address} AND user_id=${member.user_id}`;return true;
 }
 async function session(address,sessionHash){
  const [c]=await sql`SELECT * FROM club_telegram_config WHERE id`;
  if(!c?.enabled)return {enabled:false};
  const [member]=await sql`SELECT user_id,username,first_name,state FROM club_telegram_members WHERE address=${address}`;
  const [pending]=await sql`SELECT id,user_id,username,first_name,expires_at FROM club_telegram_pairings WHERE address=${address} AND session_hash=${sessionHash} AND confirmed_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1`;
  return {enabled:true,botUsername:c.bot_username,member:member??null,pending:pending??null};
 }
 async function pair(address,sessionHash){
  const c=await config();await store.limit('telegram-pair:'+address,8,600);
  const nonce=randomBytes(24).toString('base64url'),id=hash(nonce);
  await sql`UPDATE club_telegram_pairings SET expires_at=now() WHERE address=${address} AND session_hash=${sessionHash} AND confirmed_at IS NULL`;
  await sql`INSERT INTO club_telegram_pairings(id,address,session_hash,expires_at) VALUES(${id},${address},${sessionHash},now()+interval '10 minutes')`;
  return {id,url:'https://t.me/'+c.bot_username+'?start=link_'+nonce};
 }
 async function confirm(address,sessionHash,id,telegramUser){
  demand(typeof id==='string'&&/^[a-f0-9]{64}$/.test(id),400,'invalid_pairing','Start the Telegram connection again.');
  const c=await config();
  const [p]=await sql`SELECT * FROM club_telegram_pairings WHERE id=${id} AND address=${address} AND session_hash=${sessionHash} AND expires_at>now()`;
  demand(p?.user_id&&p.user_id===String(telegramUser),409,'telegram_not_confirmed','Open the bot and check the Telegram account shown here.');
  await chain.membership(address);
  const [old]=await sql`SELECT * FROM club_telegram_members WHERE address=${address}`;
  demand(!old||old.user_id===p.user_id||old.state==='revoked',409,'telegram_already_linked','Disconnect your current Telegram account before linking another.');
  try{
   await sql`SELECT club_telegram_confirm(${address},${sessionHash},${id},${p.user_id})`;
  }catch(e){if(e.code==='23505')throw new ClubError(409,'telegram_already_linked','This Telegram account is already linked to another wallet.');throw e;}
  await queue('unban:'+p.id,'unbanChatMember',{chat_id:c.chat_id,user_id:Number(p.user_id),only_if_banned:true});await deliver('unban:'+p.id);
  return session(address,sessionHash);
 }
 async function invite(address,requestId){
  demand(typeof requestId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId),400,'invalid_request','Try opening the group again.');
  const c=await config(),[m]=await sql`SELECT * FROM club_telegram_members WHERE address=${address}`;
  demand(m&&await check(m,true),403,'telegram_not_linked','Connect your Telegram account first.');
  await store.limit('telegram-invite:'+address,8,600);
  const [existing]=await sql`SELECT * FROM club_telegram_invites WHERE address=${address} AND user_id=${m.user_id} AND state='live' AND expires_at>now() ORDER BY created_at DESC LIMIT 1`;
  if(existing)return {url:existing.invite_link,expiresAt:existing.expires_at};
  const [row]=await sql`INSERT INTO club_telegram_invites(id,address,user_id,state,expires_at) VALUES(${requestId}::uuid,${address},${m.user_id},'reserved',now()+interval '10 minutes') ON CONFLICT DO NOTHING RETURNING *`;
  const old=row??(await sql`SELECT * FROM club_telegram_invites WHERE id=${requestId}::uuid`)[0];
  demand(old?.address===address&&old.user_id===m.user_id,409,'invalid_request','Start a new group request.');
  demand(new Date(old.expires_at).getTime()>Date.now()&&old.state!=='used'&&old.state!=='revoked',409,'invite_expired','Start a new group request.');
  await queue('invite:'+requestId,'createChatInviteLink',{chat_id:c.chat_id,name:'Claus '+requestId.slice(0,8),expire_date:Math.floor(new Date(old.expires_at).getTime()/1000),creates_join_request:true});
  const sent=await deliver('invite:'+requestId);
  demand(sent?.state==='done'&&sent.result?.invite_link,503,'invite_pending','The invitation is not confirmed yet. Try again shortly.');
  await sql`UPDATE club_telegram_invites SET state='live',invite_link=${sent.result.invite_link} WHERE id=${requestId}::uuid AND state='reserved'`;
  return {url:sent.result.invite_link,expiresAt:old.expires_at};
 }
 async function unlink(address){
  const [m]=await sql`SELECT * FROM club_telegram_members WHERE address=${address}`;if(m)await revoke(m,'disconnected');return {ok:true};
 }
 async function handle(update){
  const c=await config(),join=update.chat_join_request,msg=update.message??update.edited_message;
  if(join&&String(join.chat.id)===c.chat_id){
   const uid=userId(join.from?.id),[m]=await sql`SELECT * FROM club_telegram_members WHERE user_id=${uid}`;
   const [i]=await sql`SELECT * FROM club_telegram_invites WHERE invite_link=${join.invite_link?.invite_link??''}`;
   const allowed=inviteMatches(i,m,join)&&await check(m,true);
   const id='join:'+update.update_id;await queue(id,allowed?'approveChatJoinRequest':'declineChatJoinRequest',{chat_id:c.chat_id,user_id:Number(uid)});const sent=await deliver(id);
   if(allowed&&sent?.state==='done'){
    await sql`UPDATE club_telegram_members SET state='joined',joined_at=coalesce(joined_at,now()),updated_at=now() WHERE user_id=${uid}`;
    await sql`UPDATE club_telegram_invites SET state='used' WHERE id=${i.id}::uuid`;
    await queue('revoke-invite:'+i.id,'revokeChatInviteLink',{chat_id:c.chat_id,invite_link:i.invite_link});await deliver('revoke-invite:'+i.id);
   }
   return;
  }
  const changed=update.chat_member;
  if(changed&&String(changed.chat.id)===c.chat_id){
   const uid=userId(changed.new_chat_member?.user?.id),status=changed.new_chat_member?.status;
   if(['left','kicked'].includes(status))await sql`UPDATE club_telegram_members SET state=CASE WHEN state='revoked' THEN state ELSE 'left' END,updated_at=now() WHERE user_id=${uid}`;
   if(['member','administrator','restricted'].includes(status)&&uid!==c.bot_id&&uid!==c.owner_id){
    const [m]=await sql`SELECT * FROM club_telegram_members WHERE user_id=${uid}`;
    if(!m||!await check(m,true)){await queue('unverified-join:'+update.update_id,'banChatMember',{chat_id:c.chat_id,user_id:Number(uid),revoke_messages:false});await deliver('unverified-join:'+update.update_id);}
    else await sql`UPDATE club_telegram_members SET state='joined',joined_at=coalesce(joined_at,now()) WHERE user_id=${uid}`;
   }
  }
  if(!msg||!userId(msg.from?.id)||msg.from.is_bot||msg.sender_chat)return;
  const uid=String(msg.from.id);
  if(msg.chat.type==='private'){
   const nonce=msg.text?.match(/^\/start(?:@\w+)? link_([A-Za-z0-9_-]{32})$/)?.[1];
   if(nonce){
    const [p]=await sql`UPDATE club_telegram_pairings SET user_id=${uid},username=${msg.from.username??null},first_name=${String(msg.from.first_name??'').slice(0,64)} WHERE id=${hash(nonce)} AND expires_at>now() AND confirmed_at IS NULL AND (user_id IS NULL OR user_id=${uid}) RETURNING id`;
    await dm('pair-start:'+update.update_id,uid,p?'Telegram received. Return to claus.si/Club and confirm that this is your account to finish the NFT check.':'This connection expired or is already claimed. Start again at claus.si/Club.',[[{text:'Return to Claus Club',url:'https://claus.si/Club'}]]);
   }else if(/^\/(start|club|help)(?:@\w+)?(?:\s|$)/.test(msg.text??''))await dm('help:'+update.update_id,uid,'Claus Club is the private community for held or staked Claus NFTs. Connect your wallet at claus.si/Club, link this Telegram account, then request your invitation. I never need your seed phrase or a token transfer.',[[{text:'Verify NFT access',url:'https://claus.si/Club'}]]);
   return;
  }
  if(String(msg.chat.id)!==c.chat_id)return;
  const [m]=await sql`SELECT * FROM club_telegram_members WHERE user_id=${uid}`;
  if(!m||!await check(m))return;
  let text=msg.text??msg.caption??'';
  if(msg.photo)text+=(text?'\n':'')+'[Telegram photo attached; image contents are not available to Claus.]';
  else if(msg.document||msg.voice||msg.video||msg.audio)text+=(text?'\n':'')+'[Telegram attachment; file contents are not available to Claus.]';
  if(!text.trim())return;
  if([...text].length>2000)text=[...text].slice(0,1950).join('')+'\n[Message truncated to the Club context limit.]';
  await sql`SELECT club_telegram_ingest(${c.chat_id},${msg.message_id}::bigint,${uid},${text},${msg.reply_to_message?.message_id??null}::bigint,${!!update.edited_message})`;
  await wake().catch(()=>{});
 }
 async function process(limit=4){
  // Sending is never replayed after an uncertain transport result. Telegram
  // provides no idempotency key for messages or invitation creation.
  await sql`UPDATE club_telegram_outbox SET state=CASE WHEN method IN ('sendMessage','createChatInviteLink') THEN 'uncertain' ELSE 'pending' END,error_code='worker_interrupted',lease_until=NULL WHERE state='sending' AND lease_until<now()`;
  for(let n=0;n<limit;n++){
   const [u]=await sql`UPDATE club_telegram_updates SET state='working',lease_until=now()+interval '60 seconds',attempts=attempts+1 WHERE id=(SELECT id FROM club_telegram_updates WHERE (state='pending' OR state='working' AND lease_until<now()) AND (lease_until IS NULL OR lease_until<now()) ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`;
   if(!u)break;
   try{await handle(u.payload);await sql`UPDATE club_telegram_updates SET state='done',completed_at=now(),lease_until=NULL,payload='{}'::jsonb WHERE id=${u.id}`;}
   catch(e){await sql`UPDATE club_telegram_updates SET state='pending',lease_until=now()+interval '30 seconds',error_code=${String(e.code??'processing_unavailable').slice(0,60)} WHERE id=${u.id}`;break;}
  }
  const out=await sql`SELECT id FROM club_telegram_outbox WHERE state='pending' AND next_at<=now() ORDER BY created_at LIMIT 5`;
  for(const r of out)await deliver(r.id);
 }
 async function maintenance(){
  const activation=await reconcileTelegramActivation({sql,call,wake});
  if(!activation.active)return {processed:true,rechecked:0,activation:activation.state};
  await process(8);
  const members=await sql`SELECT * FROM club_telegram_members WHERE state IN ('verified','joined') AND next_check_at<=now() ORDER BY next_check_at LIMIT 12`;
  for(const m of members){try{await check(m,true);}catch{await sql`UPDATE club_telegram_members SET next_check_at=now()+interval '1 minute' WHERE address=${m.address}`;}}
  return {processed:true,rechecked:members.length};
 }
 async function receipt(clubId){
  const row=await deliver('club-message:'+clubId);
  return row?{channel:'telegram',state:row.state,messageId:row.result?.message_id??null}:null;
 }
 async function context(){
  const [c]=await sql`SELECT * FROM club_telegram_config WHERE id AND enabled`;if(!c)return null;
  const members=await sql`SELECT m.address,m.username AS "clubUsername",m.x_user_id AS "xUserId",m.x_username AS "xUsername",t.user_id AS "telegramUserId",t.username AS "telegramUsername",t.first_name AS "displayName" FROM club_telegram_members t JOIN club_members m USING(address) WHERE t.state IN ('verified','joined')`;
  const messages=await sql`SELECT club_id::text AS "clubMessageId",telegram_id::text AS "telegramMessageId" FROM club_telegram_messages ORDER BY club_id DESC LIMIT 60`;
  return {channel:'telegram',botUsername:c.bot_username,members,messages,visibility:'private_club',instructionAuthority:false,meaning:'This is the same Claus Club and the same Claus, now chatting through Telegram. New top-level Claus messages and replies to mapped Telegram messages are delivered there. Exact linked member IDs join their existing wallet identity; never infer a different account from a similar name. Website ideas, ballots, topics and archive stay on claus.si/Club. New Club updates, mapped edits, deletions, pins, reactions and member mutes are mirrored. Hide/undo, slowmode and website topic changes apply only on the website; they do not remove or restore Telegram messages. Attachment markers contain no image or audio content. A delivery receipt with state done confirms Telegram delivery; pending/uncertain/failed never does.'};
 }
 return {config,async enabled(){const [c]=await sql`SELECT enabled FROM club_telegram_config WHERE id`;return c?.enabled===true;},session,pair,confirm,invite,unlink,queue,deliver,process,maintenance,receipt,context,
  async receive(update){demand(Number.isSafeInteger(update?.update_id)&&update.update_id>=0,400,'invalid_update','Invalid update.');await sql`INSERT INTO club_telegram_updates(id,payload) VALUES(${update.update_id},${JSON.stringify(update)}::jsonb) ON CONFLICT DO NOTHING`;await process();return {ok:true};}
 };
}
