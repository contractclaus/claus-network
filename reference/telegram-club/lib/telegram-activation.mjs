const privateGroup=chat=>chat.type==='supergroup'&&!chat.username&&!(chat.active_usernames?.length);
export async function reconcileTelegramActivation({sql,call,wake=async()=>{},env=process.env}){
 const [config]=await sql`SELECT * FROM club_telegram_config WHERE id`;
 if(!config)return {active:false,state:'unconfigured'};
 if(config.enabled)return {active:true,state:'active'};
 if(env.CLUB_TELEGRAM_AUTO_ACTIVATE!=='true')return {active:false,state:'awaiting_activation'};
 const chat=await call('getChat',{chat_id:config.chat_id});
 if(String(chat.id)!==config.chat_id||!privateGroup(chat))return {active:false,state:'awaiting_private_group'};
 const me=await call('getMe',{});
 if(String(me.id)!==config.bot_id||me.username!==config.bot_username)throw Error('telegram_bot_identity_changed');
 const bot=await call('getChatMember',{chat_id:config.chat_id,user_id:me.id});
 const owner=await call('getChatMember',{chat_id:config.chat_id,user_id:Number(config.owner_id)});
 if(bot.status!=='administrator'||!bot.can_invite_users||!bot.can_restrict_members||!bot.can_delete_messages||!bot.can_pin_messages||owner.status!=='creator')return {active:false,state:'awaiting_group_rights'};
 const url='https://claus.si/api/club-telegram',prior=await call('getWebhookInfo',{});
 if(prior.url&&prior.url!==url)throw Error('telegram_existing_webhook_requires_reconciliation');
 if(typeof env.CLUB_TELEGRAM_WEBHOOK_SECRET!=='string'||env.CLUB_TELEGRAM_WEBHOOK_SECRET.length<32)throw Error('telegram_webhook_secret_missing');
 await call('setWebhook',{url,secret_token:env.CLUB_TELEGRAM_WEBHOOK_SECRET,max_connections:1,allowed_updates:['message','edited_message','my_chat_member','chat_member','chat_join_request'],drop_pending_updates:false});
 const hook=await call('getWebhookInfo',{});if(hook.url!==url)throw Error('telegram_webhook_unconfirmed');
 const activated=await sql`UPDATE club_telegram_config SET enabled=true,activated_at=coalesce(activated_at,now()) WHERE id AND NOT enabled AND chat_id=${config.chat_id} AND bot_id=${config.bot_id} RETURNING enabled`;
 if(activated.length)await wake().catch(()=>{});
 return {active:true,state:'active',newlyActivated:activated.length>0};
}
