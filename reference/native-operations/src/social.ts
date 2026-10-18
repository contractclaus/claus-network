import {nativeContinuity} from './native-continuity.js';
import {outgoingActionRisk} from './security/communication-policy.mjs';
import {xPersonContinuity} from './person-continuity.js';
import {networkOperations,networkOperationsEnabled} from './network-operations.js';
import {clubDue} from './club.js';
import {randomUUID} from 'node:crypto';
import {sql,once,actionProgress,journal,ConfirmedFailure,configuration,state,pauseIdle} from './store.js';
import {directlyAddressesClaus,receivedClausInteraction,fullXPost,withXMedia,getXPost,ownXId,postFields,xMediaFields,xReady,xRequest,verifyX,validatePost,type Attribution} from './x.js';
import {publicState,publicationContext,assertFreshPublicDecision,type PublicDecisionContext} from './public.js';
import {publicChannelBlocked,twitterOnly,type Configuration} from './config.js';
import {xUserFields,replyExclusion,originalPostSchedule,replyVerificationTypes} from './twitter-policy.js';
import {replyDelivery,type ReplyDelivery} from './reply-delivery.js';
import {securitySignal} from './operator-attention.js';
import {mediaForX} from './visuals.js';
import {gifForX} from './reaction-gifs.js';
import {relatedUnresolvedReply,uncertainReplyReason} from './reply-isolation.js';
import {originalDelivery} from './original-delivery.js';
import {blockedAccountReason,ownerAccountBlocked,type BlockedXAccount} from './account-blocklist.js';
import {ecosystemContext} from './ecosystem.js';
import {cachedXContext,replyConversationContext,validReplyContext} from './x-context.js';
import {searchPage} from './context.js';
import {messageAge,relatedSocialHistory,recentSocialHistory} from './social-history.js';

export function highestPostId(ids:(string|null|undefined)[]):string|null {
  return ids.reduce<string|null>((high,id)=>id&&(!high||BigInt(id)>BigInt(high))?id:high,null);
}
export function mentionPage(result:any) {
  if(result.errors?.length||(!Array.isArray(result.data)&&result.meta?.result_count!==0))throw Error('x_mentions_incomplete');
  const posts=(result.data??[]).map((p:any)=>{const author=result.includes?.users?.find((u:any)=>u.id===p.author_id);return {...withXMedia(p,result.includes),username:author?.username,authorVerification:author?{id:author.id,verified:author.verified,verified_type:author.verified_type}:null,url:`https://x.com/i/status/${p.id}`};});
  if(posts.some((p:any)=>!/^\d{1,19}$/.test(p.id??'')||!/^\d{1,19}$/.test(p.author_id??'')||typeof p.text!=='string'))throw Error('x_mentions_invalid');
  return {posts,next:result.meta?.next_token??null,high:highestPostId(posts.map((p:any)=>p.id))};
}
export function consentCommand(post:any) {
  const t=String(post.text??'').replace(/@[a-z0-9_]+/gi,'').trim().replace(/[.!?]+$/,'').toLowerCase();
  if(/^(stop|unsubscribe|stop replying(?: to me)?|please stop replying(?: to me)?|do not reply(?: to me)?|don't reply(?: to me)?|antworte mir nicht mehr|nicht mehr antworten)$/.test(t))return 'stop';
  if(/^(resume|reply again|you can reply again|antworte wieder)$/.test(t))return 'resume';
  return null;
}
export async function pollMentions() {
  const owner=randomUUID(),db=sql();
  const [poll]=await db`UPDATE claus_x_poll SET lease_owner=${owner},lease_until=now()+interval '45 seconds' WHERE id=1 AND next_poll_at<=now() AND (lease_until IS NULL OR lease_until<now()) RETURNING *`;
  if(!poll)return;
  try {
    const q=new URLSearchParams({'max_results':'100','tweet.fields':postFields,expansions:'author_id,attachments.media_keys','media.fields':xMediaFields,'user.fields':xUserFields});
    if(poll.since_id)q.set('since_id',poll.since_id);else q.set('start_time',new Date(poll.started_at).toISOString().replace(/\.\d{3}Z$/,'Z'));
    if(poll.page_token)q.set('pagination_token',poll.page_token);
    const page=mentionPage(await xRequest(`users/${ownXId}/mentions?${q}`));
    // Each insert commits before advancing a cursor. An interrupted page is
    // replayed safely, including consent changes, rather than losing messages.
    for(const post of page.posts) {
      if(!receivedClausInteraction(post))continue;
      await db`INSERT INTO claus_x_inbox(post_id,author_id,conversation_id,post,operator_issue) VALUES(${post.id},${post.author_id},${post.conversation_id??post.id},${JSON.stringify(post)}::jsonb,${securitySignal(post)}) ON CONFLICT(post_id) DO NOTHING`;
      const command=consentCommand(post);
      if(command==='stop')await db`INSERT INTO claus_x_optouts(author_id,post_id) VALUES(${post.author_id},${post.id}) ON CONFLICT(author_id) DO UPDATE SET post_id=excluded.post_id,enabled=true,created_at=now() WHERE excluded.post_id::numeric>claus_x_optouts.post_id::numeric`;
      if(command==='resume')await db`INSERT INTO claus_x_optouts(author_id,post_id,enabled) VALUES(${post.author_id},${post.id},false) ON CONFLICT(author_id) DO UPDATE SET post_id=excluded.post_id,enabled=false,created_at=now() WHERE excluded.post_id::numeric>claus_x_optouts.post_id::numeric`;
      if(command)await db`UPDATE claus_x_inbox SET status='skipped',reason=${'consent_'+command} WHERE post_id=${post.id} AND status IN ('pending','retrying')`;
    }
    const high=highestPostId([poll.high_id,page.high,poll.since_id]);
    await db`UPDATE claus_x_poll SET since_id=${page.next?poll.since_id:high},page_token=${page.next},high_id=${page.next?high:null},next_poll_at=now()+(${page.next?1:60}*interval '1 second'),lease_owner=NULL,lease_until=NULL,last_error=NULL WHERE id=1 AND lease_owner=${owner}`;
  } catch(error) {
    const reason=error instanceof Error&&/^x_[a-z0-9_]+$/.test(error.message)?error.message:'x_mentions_unavailable';
    await db`UPDATE claus_x_poll SET lease_owner=NULL,lease_until=NULL,next_poll_at=now()+interval '2 minutes',last_error=${reason} WHERE id=1 AND lease_owner=${owner}`;
  }
}
export async function skipOwnerBlockedReplies(accounts:BlockedXAccount[],db:SocialQuery=sql()) {
  if(!accounts.length)return [];
  return db`UPDATE claus_x_inbox i SET status='skipped',reason=${ownerAccountBlocked},deferred_until=NULL
    WHERE i.status IN ('pending','retrying')
      AND (i.author_id=ANY(${accounts.flatMap(a=>a.id?[a.id]:[])}::text[]) OR lower(i.post->>'username')=ANY(${accounts.map(a=>a.username)}::text[]))
      AND NOT EXISTS(SELECT 1 FROM claus_actions a LEFT JOIN claus_x_inbox source ON source.post_id=a.input->>'replyTo'
        WHERE a.kind='x_post' AND a.status NOT IN ('completed','failed')
          AND (a.input->>'replyTo'=i.post_id OR a.input->>'replyAuthorId'=i.author_id OR source.author_id=i.author_id))
    RETURNING i.post_id`;
}
export async function filterTwitterInbox(config:Configuration|undefined=undefined,db:SocialQuery=sql()) {
  config??=await configuration();
  await skipOwnerBlockedReplies(config.settings.blockedXAccounts??[],db);
  const rows=await db`SELECT post_id,post FROM claus_x_inbox WHERE status='pending' AND (deferred_until IS NULL OR deferred_until<=now()) ORDER BY observed_at LIMIT 100`;
  let refreshed=0;
  for(const row of rows) {
    // Old inbox records predate badge collection. Refresh once; never infer a
    // eligible badge from a familiar username or from an old verification boolean.
    let post=row.post;
    if(!Object.hasOwn(post,'authorVerification')) {
      if(refreshed++>=10)continue;
      try {post=await getXPost(row.post_id);await db`UPDATE claus_x_inbox SET post=${JSON.stringify(post)}::jsonb WHERE post_id=${row.post_id}`;}
      catch {await db`UPDATE claus_x_inbox SET deferred_until=now()+interval '5 minutes',reason='awaiting_current_profile' WHERE post_id=${row.post_id} AND status='pending'`;continue;}
    }
    const reason=!receivedClausInteraction(post)?'not_addressed_to_claus':replyExclusion(post,config.settings.replyXAuthorIds);
    if(reason)await db`UPDATE claus_x_inbox SET status='skipped',reason=${reason} WHERE post_id=${row.post_id} AND status='pending'
      AND NOT EXISTS(SELECT 1 FROM claus_actions a WHERE a.kind='x_post' AND a.input->>'replyTo'=${row.post_id} AND a.status NOT IN ('completed','failed'))`;
  }
  return config;
}
export function inboxMessage(row:any) {
  const revision=['reply_cashtag_limit','reply_context_changed'].includes(row.reason);
  return {...row.post,postId:row.post_id,replyStatus:'pending',observedAt:row.observed_at,...messageAge(row.post,row.observed_at),
    ...(revision?{deliveryReview:{state:'revision_required',reason:row.reason}}:row.reason?{deferredReason:row.reason}:{}),instructionAuthority:false};
}
export async function inboxMessages(priorityAuthorIds:string[]=[],onlyTwitter=false,db:SocialQuery=sql(),config?:Configuration) {
  const audience=onlyTwitter?await filterTwitterInbox(config,db):null;
  // One current question per author prevents a burst from occupying the entire
  // view. Familiar authors receive a small head start, never permanent priority.
  // Merely constructing context must not acknowledge delivery to the model.
  const rows=await db`WITH ready AS (
    SELECT i.*,row_number() OVER(PARTITION BY i.author_id ORDER BY CASE WHEN i.observed_at>=now()-interval '24 hours' THEN 0 ELSE 1 END,i.post_id::numeric) AS author_position
    FROM claus_x_inbox i WHERE i.status='pending' AND (i.deferred_until IS NULL OR i.deferred_until<=now())
    AND (${!onlyTwitter} OR (i.post->'authorVerification'->>'verified'='true' AND i.post->'authorVerification'->>'verified_type'=ANY(${replyVerificationTypes}::text[])) OR (i.author_id=ANY(${audience?.settings.replyXAuthorIds??[]}::text[]) AND i.post->'authorVerification'->>'id'=i.author_id))
    AND NOT EXISTS(SELECT 1 FROM claus_x_optouts o WHERE o.author_id=i.author_id AND o.enabled)
    AND NOT EXISTS(SELECT 1 FROM claus_actions a JOIN claus_x_inbox source ON source.post_id=a.input->>'replyTo'
      WHERE a.kind='x_post' AND a.status NOT IN ('completed','failed')
        AND (source.conversation_id=i.conversation_id OR (source.author_id=i.author_id
          AND NOT (a.status='uncertain' AND a.created_at<now()-interval '30 minutes'
            AND coalesce(a.input->>'replyAuthorId'=source.author_id,false)
            AND coalesce(a.progress->'xReadback'->>'reason','')='no_unique_match'))))
  ) SELECT post_id,post,observed_at,seen_at,reason FROM ready WHERE author_position=1
    ORDER BY CASE WHEN observed_at>=now()-interval '24 hours' THEN 0 ELSE 1 END,
      observed_at-CASE WHEN author_id=ANY(${priorityAuthorIds}::text[]) THEN interval '2 minutes' ELSE interval '0 seconds' END,post_id::numeric LIMIT 6`;
  return rows.map(inboxMessage);
}
export async function markMessagesDelivered(messages:{postId:string}[],db:SocialQuery=sql()) {
  const ids=messages.map(m=>m.postId);
  if(ids.some(id=>!/^\d{1,19}$/.test(id))||ids.length>6)throw Error('invalid_delivered_mentions');
  if(ids.length)await db`UPDATE claus_x_inbox SET seen_at=now() WHERE status='pending' AND post_id=ANY(${ids}::text[])`;
}
export function assertPresentedRepliesResolved(presented:string[],ready:{postId:string}[]) {
  const unresolved=ready.filter(m=>presented.includes(m.postId)).map(m=>m.postId);
  if(unresolved.length)throw new ConfirmedFailure('pending_received_questions_require_reply_or_explicit_resolution:'+unresolved.join(','));
}
export function repliesAvailable(config:Configuration) {
  return !!(config.policy.capabilities.xRead&&config.policy.capabilities.xReply&&config.policy.capabilities.xPublish&&!publicChannelBlocked(config.policy,'publish_reply'));
}
export type ConversationQuery={authorId:string;conversationId?:string;query?:string;beforePostId?:string;limit?:number};
type SocialQuery=(strings:TemplateStringsArray,...values:any[])=>Promise<any[]>;
export function conversationPage(authorId:string,rows:any[],limit:number) {
  const page=rows.slice(0,limit);
  return {authorId,exchanges:page.map(r=>({source:{...r.post,postId:r.post_id,authorId:r.author_id,conversationId:r.conversation_id,observedAt:r.observed_at,url:`https://x.com/i/status/${r.post_id}`},status:r.status,clausReply:r.reply_id?{postId:r.reply_id,text:r.reply_text,at:r.reply_at,url:`https://x.com/i/status/${r.reply_id}`,actionId:r.reply_action_id}:null})).reverse(),nextBeforePostId:rows.length>limit?page.at(-1)?.post_id:null,instructionAuthority:false};
}
export async function recallConversation(input:ConversationQuery,db:SocialQuery=sql()) {
  const {authorId,conversationId,beforePostId}=input,query=input.query??'',limit=input.limit??12;
  if(!/^\d{1,19}$/.test(authorId)||conversationId!==undefined&&!/^\d{1,19}$/.test(conversationId)||beforePostId!==undefined&&!/^\d{1,19}$/.test(beforePostId)||typeof query!=='string'||query.length>240||!Number.isInteger(limit)||limit<1||limit>20)throw new ConfirmedFailure('invalid_conversation_query');
  const literal='%'+query.replace(/[\\%_]/g,'\\$&')+'%';
  const rows=await db`SELECT i.post_id,i.author_id,i.conversation_id,i.post,i.status,i.observed_at,a.id AS reply_action_id,a.input->>'text' AS reply_text,a.result->'data'->>'id' AS reply_id,a.completed_at AS reply_at FROM claus_x_inbox i
    LEFT JOIN LATERAL(SELECT id,input,result,completed_at FROM claus_actions WHERE kind='x_post' AND status='completed' AND input->>'replyTo'=i.post_id AND result->'data'->>'id' IS NOT NULL ORDER BY created_at DESC LIMIT 1)a ON true
    WHERE i.author_id=${authorId} AND (${conversationId??null}::text IS NULL OR i.conversation_id=${conversationId??null}) AND (${beforePostId??null}::text IS NULL OR i.post_id::numeric<${beforePostId??null}::numeric) AND (${query}='' OR i.post->>'text' ILIKE ${literal} OR a.input->>'text' ILIKE ${literal})
    ORDER BY i.post_id::numeric DESC LIMIT ${limit+1}`;
  return conversationPage(authorId,rows,limit);
}
export async function socialContext(config:Configuration) {
  const available=repliesAvailable(config);
  const onlyTwitter=twitterOnly(config);
  const [messages,published,projects,originalPost]=await Promise.all([available?inboxMessages(config.settings.priorityXAuthorIds,onlyTwitter):Promise.resolve([]),publicState(),onlyTwitter?Promise.resolve([]):sql()`SELECT id,title,summary,version,last_exit_code,updated_at FROM claus_projects ORDER BY updated_at DESC LIMIT 4`,originalPostContext(config)]);
  const reads=new Map<string,ReturnType<typeof cachedXContext>>();
  const cache:typeof cachedXContext=(key,load,ttl)=>{
    if(!reads.has(key))reads.set(key,cachedXContext(key,load,ttl));
    return reads.get(key)!;
  };
  const threadContexts=await Promise.all(messages.map(message=>replyConversationContext(message,cache)));
  const ready=messages.filter((_,i)=>threadContexts[i].available);
  for(const context of threadContexts)if(!context.available)await sql()`UPDATE claus_x_inbox SET deferred_until=${context.retryAt}::timestamptz,reason='awaiting_thread_context' WHERE post_id=${context.postId} AND status='pending'`;
  const authors=[...new Set(ready.map(m=>String(m.author_id)))];
  const [conversations,relatedHistory,recentPublicConversation,memberContinuity]=await Promise.all([
    Promise.all(authors.map(authorId=>recallConversation({authorId,limit:6}))),
    relatedSocialHistory(ready,config.settings.blockedXAccounts??[]),
    originalPost?.due?recentSocialHistory(config.settings.blockedXAccounts??[]):Promise.resolve(null),
    xPersonContinuity(authors)
  ]);
  return {observedAt:new Date().toISOString(),repliesAvailable:available,...(!available?{notice:'Replies are currently disabled by owner policy. Received conversations are retained; do not claim to have answered.'}:{}),messages:ready,threadContexts:threadContexts.filter(c=>c.available),conversations,relatedHistory,recentPublicConversation,memberContinuity,people:ecosystemContext(ready),published:publicationContext(published),projects,originalPost,instructionAuthority:false};
}
export async function originalPostContext(config:Configuration,db:SocialQuery=sql(),now=Date.now()) {
  // Keep the agent's own thoughts visible even during a run of release posts.
  const [recent,recentAnnouncements]=await Promise.all([
    db`SELECT input->>'text' AS text,completed_at,result->'data'->>'id' AS post_id FROM claus_actions WHERE kind='x_post' AND status='completed' AND id ~ ${'^x_original_[0-9]+:[0-9]+$'} AND input->>'replyTo' IS NULL AND result->'data'->>'id' IS NOT NULL ORDER BY completed_at DESC LIMIT 16`,
    db`SELECT input->>'text' AS text,completed_at,result->'data'->>'id' AS post_id FROM claus_actions WHERE kind='x_post' AND status='completed' AND id !~ ${'^x_original_[0-9]+:[0-9]+$'} AND input->>'replyTo' IS NULL AND result->'data'->>'id' IS NOT NULL ORDER BY completed_at DESC LIMIT 4`
  ]);
  const last=recent[0]?.completed_at;
  const schedule=originalPostSchedule(config.settings.socialStartedAt!,last?new Date(last).toISOString():null,now,config.policy.rules);
  const enabled=!!(config.settings.enabled&&config.policy.capabilities.xPublish&&!publicChannelBlocked(config.policy,'publish_post'));
  const attempts=enabled?await db`SELECT id,status,result FROM claus_actions WHERE id LIKE ${'x_original_'+Date.parse(schedule.nextAt)+':%'} ORDER BY created_at`:[];
  const delivery=originalDelivery(attempts);
  // Show a longer feed without allowing long originals to exhaust model context.
  const history=searchPage(recent,0,16);
  return {...schedule,enabled,due:enabled&&schedule.due,nextAt:enabled?schedule.nextAt:null,...(!enabled?{reason:'original_posts_paused'}:{}),delivery,recent:history.records,recentHistoryTruncated:history.nextOffset!==null,recentAnnouncements};
}
export async function publishOriginal(text:string,attributions:Attribution[],config:Configuration,decisionContext?:PublicDecisionContext,imageId?:string,gifId?:string) {
  if(!config.settings.enabled||!config.policy.capabilities.xPublish||publicChannelBlocked(config.policy,'publish_post'))return {published:false,reason:'original_posts_paused'};
  validatePost(text,attributions,'original',!!gifId);
  if(imageId&&gifId)throw new ConfirmedFailure('choose_image_or_gif');
  const schedule=await originalPostContext(config);
  if(!schedule.due||!schedule.nextAt)return {published:false,reason:'original_post_not_due',nextAt:schedule.nextAt};
  const prefix='x_original_'+Date.parse(schedule.nextAt);
  const prior=await sql()`SELECT id,status,result FROM claus_actions WHERE id LIKE ${prefix+':%'} ORDER BY created_at`;
  const done=prior.find(p=>p.status==='completed');if(done)return done.result;
  if(prior.some(p=>p.status!=='failed'))throw Error('x_original_requires_reconciliation');
  if(!originalDelivery(prior).mayCompose)return {published:false,delivery:'blocked',reason:'original_post_requires_review'};
  const id=prefix+':'+prior.length;
  const account=await verifyX();
  const gif=await gifForX(gifId);
  try {return await once(id,'x_post',{text,...(imageId?{imageId}:{}),...(gif?{gifId,gifMediaKey:gif.mediaKey}:{}),...(attributions.length?{attributions}:{}),...(decisionContext?{decisionContext}:{})},async()=>{
    const current=await configuration();
    if(!current.settings.enabled||!current.policy.capabilities.xPublish||publicChannelBlocked(current.policy,'publish_post'))throw new ConfirmedFailure('publication_disabled');
    if(decisionContext)assertFreshPublicDecision(decisionContext,current.revision,await publicState());
    const media=gif?.media??await mediaForX(imageId);
    const latest=await configuration();
    if(!latest.settings.enabled||!latest.policy.capabilities.xPublish||publicChannelBlocked(latest.policy,'publish_post'))throw new ConfirmedFailure('publication_disabled');
    if(decisionContext)assertFreshPublicDecision(decisionContext,latest.revision,await publicState());
    const r=await xRequest('tweets','POST',{text,...(media?{media}:{})},undefined,id);
    if(!/^\d{1,19}$/.test(r.data?.id??''))throw Error('x_post_response_missing');
    await actionProgress(id,{result:r});
    await journal('x_post','Published an original post',{postId:r.data.id,account:account.username});return r;
  });}catch(error){
    if(error instanceof ConfirmedFailure&&error.message==='publication_context_changed')return {published:false,delivery:'revision_required',reason:'publication_context_changed',sentToX:false};
    throw error;
  }
}
export function mentionDeferral(outcome:string,reviewAt?:string,now=Date.now()) {
  if(outcome!=='defer'){if(reviewAt!==undefined)throw new ConfirmedFailure('review_time_only_for_deferral');return null;}
  const when=typeof reviewAt==='string'?Date.parse(reviewAt):NaN;
  if(!Number.isFinite(when)||when<=now)throw new ConfirmedFailure('future_mention_review_time_required');
  return new Date(when).toISOString();
}
export async function resolveMention(id:string,outcome:string,reason:string,reviewAt?:string) {
  if(!/^\d{1,19}$/.test(id)||!['skip','opt_out','defer'].includes(outcome)||typeof reason!=='string'||!reason.trim()||reason.length>1000)throw new ConfirmedFailure('invalid_mention_resolution');
  const deferredUntil=mentionDeferral(outcome,reviewAt);
  const db=sql(),[row]=await db`SELECT author_id FROM claus_x_inbox WHERE post_id=${id}`;if(!row)throw new ConfirmedFailure('mention_not_received');
  if(outcome==='defer') {
    const delivery=replyDelivery(await replyAttempts(id,db));
    if(delivery.state!=='new')return saveReplyDelivery(id,delivery,db);
  }
  if(outcome==='opt_out')await db`INSERT INTO claus_x_optouts(author_id,post_id) VALUES(${row.author_id},${id}) ON CONFLICT(author_id) DO UPDATE SET post_id=excluded.post_id,enabled=true,created_at=now() WHERE excluded.post_id::numeric>claus_x_optouts.post_id::numeric`;
  const updated=await db`UPDATE claus_x_inbox SET status=${outcome==='defer'?'pending':'skipped'},reason=${reason},deferred_until=${deferredUntil}::timestamptz WHERE post_id=${id} AND status IN ('pending','retrying') RETURNING post_id`;
  return updated.length?{postId:id,outcome,...(deferredUntil?{reviewAt:deferredUntil}:{})}:{error:'mention_already_resolved'};
}
async function replyAttempts(id:string,db:SocialQuery) {
  return db`SELECT id,status,result,input,created_at,completed_at FROM claus_actions WHERE kind='x_post' AND input->>'replyTo'=${id} ORDER BY created_at,id`;
}
async function saveReplyDelivery(id:string,delivery:ReplyDelivery,db:SocialQuery) {
  if(delivery.state==='published') {
    await db`UPDATE claus_x_inbox SET status='answered',reply_id=${delivery.result.data.id},deferred_until=NULL WHERE post_id=${id}`;
    return delivery.result;
  }
  if(delivery.state==='uncertain') {
    await db`UPDATE claus_x_inbox SET status='delivery_blocked',reason=${uncertainReplyReason},deferred_until=NULL WHERE post_id=${id} AND status IN ('pending','retrying')`;
    return {published:false,delivery:'uncertain',reason:uncertainReplyReason};
  }
  if(delivery.state==='revise') {
    await db`UPDATE claus_x_inbox SET status='pending',reason=${delivery.reason},deferred_until=NULL,seen_at=NULL WHERE post_id=${id} AND status IN ('pending','retrying')`;
    return {published:false,delivery:'revision_required',reason:delivery.reason};
  }
  if(delivery.state==='retry') {
    await db`UPDATE claus_x_inbox SET status='retrying',reason='reply_retry_scheduled',deferred_until=${delivery.retryAt}::timestamptz WHERE post_id=${id} AND status IN ('pending','retrying')`;
    return {published:false,delivery:'retry_scheduled',retryAt:delivery.retryAt};
  }
  if(delivery.state==='blocked') {
    await db`UPDATE claus_x_inbox SET status='delivery_blocked',reason=${delivery.reason},deferred_until=NULL WHERE post_id=${id} AND status IN ('pending','retrying')`;
    return {published:false,delivery:'blocked',reason:delivery.reason};
  }
  return {published:false,delivery:'not_attempted'};
}
const replyServices={configuration,getXPost,verifyX,once,actionProgress,journal,xRequest,publicState};
export async function publishReply(text:string,replyTo:string,attributions:Attribution[]=[],services=replyServices,db:SocialQuery=sql(),decisionContext?:PublicDecisionContext,imageId?:string,gifId?:string,replyIntent?:'direct'|'invited_in_context') {
  if(replyIntent!==undefined&&!['direct','invited_in_context'].includes(replyIntent))throw new ConfirmedFailure('invalid_reply_intent');
  validatePost(text,attributions,'short',!!gifId);
  if(imageId&&gifId)throw new ConfirmedFailure('choose_image_or_gif');
  if(!/^\d{1,19}$/.test(replyTo))throw new ConfirmedFailure('invalid_short_reply');
  const [inbox]=await db`SELECT * FROM claus_x_inbox WHERE post_id=${replyTo}`;
  if(!inbox)throw new ConfirmedFailure('reply_requires_received_mention');
  if(inbox.status==='answered')return {data:{id:inbox.reply_id},alreadyPublished:true};
  const held=await relatedUnresolvedReply(inbox.author_id,inbox.conversation_id,db);
  if(held) {
    if(!twitterOnly(await services.configuration()))throw Error('x_reply_requires_reconciliation');
    return {published:false,delivery:'uncertain',reason:uncertainReplyReason,actionId:held};
  }
  if(!['pending','retrying'].includes(inbox.status))throw new ConfirmedFailure('mention_already_resolved');
  const skipBlocked=async()=>{
    await db`UPDATE claus_x_inbox SET status='skipped',reason=${ownerAccountBlocked},deferred_until=NULL WHERE post_id=${replyTo} AND status IN ('pending','retrying')`;
    return {published:false,skipped:true,reason:ownerAccountBlocked};
  };
  const initial=await services.configuration();
  if(blockedAccountReason({...inbox.post,author_id:inbox.author_id},initial.settings.blockedXAccounts))return skipBlocked();
  const prior=await replyAttempts(replyTo,db);let delivery=replyDelivery(prior);
  if(delivery.state==='retry'&&inbox.reason==='reply_context_changed'&&decisionContext)delivery={state:'revise',reason:'reply_context_changed'};
  if(delivery.state==='revise'&&!decisionContext)return saveReplyDelivery(replyTo,delivery,db);
  if(!['new','revise'].includes(delivery.state)&&!(delivery.state==='retry'&&delivery.due))return saveReplyDelivery(replyTo,delivery,db);
  if(delivery.state==='retry') {
    // Transport retry, not another model-written reply or a way around a rejection.
    text=delivery.input.text;attributions=delivery.input.attributions??[];
    decisionContext=delivery.input.decisionContext;
    imageId=delivery.input.imageId;
    gifId=delivery.input.gifId;
    replyIntent=delivery.input.replyIntent;
    validatePost(text,attributions,'short',!!gifId);
  }
  const [blocked]=await db`SELECT author_id FROM claus_x_optouts WHERE author_id=${inbox.author_id} AND enabled`;
  if(blocked){await db`UPDATE claus_x_inbox SET status='skipped',reason='recipient_opted_out' WHERE post_id=${replyTo} AND status IN ('pending','retrying')`;return {published:false,skipped:true,reason:'recipient_opted_out'};}
  const target=await services.getXPost(replyTo);
  if(target.author_id!==inbox.author_id)throw new ConfirmedFailure('reply_not_requested');
  const risk=outgoingActionRisk(text,{reply:true,recipient:target.username,participants:(target.entities?.mentions??[]).map((m:any)=>m.username)});
  if(risk)throw new ConfirmedFailure(risk);
  if(!receivedClausInteraction(target)||(!directlyAddressesClaus(target)&&replyIntent!=='invited_in_context')||consentCommand(target)==='stop') {
    await db`UPDATE claus_x_inbox SET status='skipped',reason='not_addressed_to_claus',deferred_until=NULL WHERE post_id=${replyTo} AND status IN ('pending','retrying')`;
    return {published:false,skipped:true,reason:'not_addressed_to_claus'};
  }
  const current=await services.configuration();
  if(!current.settings.enabled||!repliesAvailable(current))throw new ConfirmedFailure('publication_disabled');
  if(blockedAccountReason(target,current.settings.blockedXAccounts))return skipBlocked();
  const excluded=twitterOnly(current)?replyExclusion(target,current.settings.replyXAuthorIds):null;
  if(excluded){await db`UPDATE claus_x_inbox SET status='skipped',reason=${excluded} WHERE post_id=${replyTo} AND status IN ('pending','retrying')`;return {published:false,skipped:true,reason:excluded};}
  if(twitterOnly(current)&&!validReplyContext(decisionContext?.replyContexts,target)) {
    await db`UPDATE claus_x_inbox SET post=${JSON.stringify(target)}::jsonb WHERE post_id=${replyTo}`;
    return saveReplyDelivery(replyTo,{state:'revise',reason:'reply_context_changed'},db);
  }
  const account=await services.verifyX();
  // The source post, not the model turn, identifies the effect. Only a proven
  // failed request permits a new attempt. Unknown publication never resends.
  const id=`x_reply_${replyTo}:${prior.filter(p=>p.status==='failed').length}`;
  const gif=await gifForX(gifId);
  let result:any;
  try {result=await services.once(id,'x_post',{text,replyTo,replyAuthorId:target.author_id,...(replyIntent?{replyIntent}:{}),...(imageId?{imageId}:{}),...(gif?{gifId,gifMediaKey:gif.mediaKey}:{}),...(attributions.length?{attributions}:{}),...(decisionContext?{decisionContext}:{})},async()=>{
    const live=await services.configuration();
    if(!live.settings.enabled||!repliesAvailable(live))throw new ConfirmedFailure('publication_disabled');
    if(blockedAccountReason(target,live.settings.blockedXAccounts))throw new ConfirmedFailure(ownerAccountBlocked);
    const liveAudience=twitterOnly(live)?replyExclusion(target,live.settings.replyXAuthorIds):null;
    if(liveAudience)throw new ConfirmedFailure(liveAudience);
    if(decisionContext)assertFreshPublicDecision(decisionContext,live.revision,await services.publicState());
    const media=gif?.media??await mediaForX(imageId);
    const facts=decisionContext?await services.publicState():null;
    const latest=await services.configuration();
    if(!latest.settings.enabled||!repliesAvailable(latest))throw new ConfirmedFailure('publication_disabled');
    if(blockedAccountReason(target,latest.settings.blockedXAccounts))throw new ConfirmedFailure(ownerAccountBlocked);
    const latestAudience=twitterOnly(latest)?replyExclusion(target,latest.settings.replyXAuthorIds):null;
    if(latestAudience)throw new ConfirmedFailure(latestAudience);
    if(decisionContext)assertFreshPublicDecision(decisionContext,latest.revision,facts!);
    const r=await services.xRequest('tweets','POST',{text,reply:{in_reply_to_tweet_id:replyTo},...(media?{media}:{})},undefined,id);
    if(!/^\d{1,19}$/.test(r.data?.id??''))throw Error('x_reply_response_missing');
    await services.actionProgress(id,{result:r});
    await services.journal('x_post','Published a conversation reply',{postId:r.data.id,replyTo,account:account.username});return r;
  });} catch(error) {
    if(error instanceof ConfirmedFailure&&error.message===ownerAccountBlocked)return skipBlocked();
    const delivery=replyDelivery(await replyAttempts(replyTo,db));
    if(error instanceof ConfirmedFailure||delivery.state==='uncertain'&&twitterOnly(current))return saveReplyDelivery(replyTo,delivery,db);
    throw error;
  }
  await db`UPDATE claus_x_inbox SET status='answered',reply_id=${result.data.id},deferred_until=NULL WHERE post_id=${replyTo}`;
  return {...result,replyTo};
}
export async function replyRetryCandidates(db:SocialQuery=sql()) {
  return db`SELECT i.post_id,a.input FROM claus_x_inbox i
    JOIN LATERAL(SELECT input FROM claus_actions WHERE kind='x_post' AND input->>'replyTo'=i.post_id AND status='failed' ORDER BY created_at DESC LIMIT 1)a ON true
    WHERE ((i.status='pending' AND COALESCE(i.reason,'')<>ALL(${['reply_cashtag_limit','reply_context_changed']}::text[]))
      OR (i.status='retrying' AND (i.deferred_until IS NULL OR i.deferred_until<=now())))
    AND NOT EXISTS(SELECT 1 FROM claus_actions held JOIN claus_x_inbox source ON source.post_id=held.input->>'replyTo'
      WHERE held.kind='x_post' AND held.status NOT IN ('completed','failed') AND (source.author_id=i.author_id OR source.conversation_id=i.conversation_id))
    ORDER BY i.observed_at LIMIT 2`;
}
// Called inside the ordinary cycle's lease, before paid reasoning. A crash is
// recoverable from the saved action; no second scheduler or sending credential.
export async function retryReplies(db:SocialQuery=sql(),services=replyServices) {
  const config=await services.configuration();if(!config.settings.enabled||!repliesAvailable(config))return 0;
  const rows=await replyRetryCandidates(db);
  for(const row of rows) {
    const plan=replyDelivery(await replyAttempts(row.post_id,db));
    if(plan.state!=='retry'||!plan.due){await saveReplyDelivery(row.post_id,plan,db);continue;}
    try {await publishReply(plan.input.text,row.post_id,plan.input.attributions??[],services,db,plan.input.decisionContext,plan.input.imageId,plan.input.gifId);}
    catch(error) {
      if(!(error instanceof ConfirmedFailure)||error.message==='publication_disabled')throw error;
      await saveReplyDelivery(row.post_id,{state:'blocked',reason:'reply_target_needs_attention'},db);
    }
  }
  return rows.length;
}
export async function replyDeliveryOverview() {
  return sql()`SELECT post_id AS "postId",status,reason,deferred_until AS "retryAt" FROM claus_x_inbox WHERE status IN ('retrying','delivery_blocked') ORDER BY observed_at LIMIT 20`;
}
export async function wakeDecision(generation:number) {
 return nativeContinuity('native','wake','generation:'+generation,{},()=>wakeDecisionUnfenced(generation));
}
async function wakeDecisionUnfenced(generation:number) {
  const config=await configuration(),current=await state();
  if(current.generation!==generation)return {run:false,nextAt:null};
  if(!await import('./runtime-host.js').then(m=>m.runtimeHostPulse(generation)))return {run:false,nextAt:null};
  if(!config.settings.enabled){await pauseIdle(generation);return {run:false,nextAt:null};}
  if(current.status==='paused'||current.status==='blocked')return {run:false,nextAt:null};
  if(current.lease_until&&Date.parse(current.lease_until)>Date.now())return {run:false,nextAt:new Date(Date.now()+15000).toISOString()};
  let newMessage=false;
  if(config.policy.capabilities.xRead&&xReady()) {
    await pollMentions();
    if(repliesAvailable(config)) {
      if(twitterOnly(config))await filterTwitterInbox(config);
      newMessage=await pendingReplyDue(twitterOnly(config),config.settings.replyXAuthorIds)||(await replyRetryCandidates()).length>0;
    }
  }
  if(config.policy.capabilities.xPublish&&!publicChannelBlocked(config.policy,'publish_post')) {
    const schedule=await originalPostContext(config);
    if(current.status==='waiting'&&schedule.delivery.mayCompose&&schedule.nextAt&&Date.parse(schedule.nextAt)<Date.parse(current.next_at))current.next_at=schedule.nextAt;
    if(schedule.due&&schedule.delivery.mayCompose)newMessage=true;
  }
  const networkDue=networkOperationsEnabled(config)&&current.status==='waiting'?await networkOperations.inspect().catch(()=>false):false;
  return scheduledWake(current,newMessage||await clubDue(config)||networkDue);
}
export async function pendingReplyDue(onlyTwitter=false,replyAuthorIds:string[]=[],db:SocialQuery=sql()) {
  const [row]=await db`SELECT post_id FROM claus_x_inbox i WHERE status='pending'
    AND (deferred_until IS NULL OR deferred_until<=now()) AND (seen_at IS NULL OR seen_at<=now()-interval '2 minutes')
    AND (${!onlyTwitter} OR (i.post->'authorVerification'->>'verified'='true' AND i.post->'authorVerification'->>'verified_type'=ANY(${replyVerificationTypes}::text[])) OR (i.author_id=ANY(${replyAuthorIds}::text[]) AND i.post->'authorVerification'->>'id'=i.author_id))
    AND NOT EXISTS(SELECT 1 FROM claus_x_optouts o WHERE o.author_id=i.author_id AND o.enabled)
    AND NOT EXISTS(SELECT 1 FROM claus_actions a JOIN claus_x_inbox source ON source.post_id=a.input->>'replyTo'
      WHERE a.kind='x_post' AND a.status NOT IN ('completed','failed') AND (source.author_id=i.author_id OR source.conversation_id=i.conversation_id)) LIMIT 1`;
  return !!row;
}
export function scheduledWake(current:any,newMessage:boolean,now=Date.now()) {
  return {run:Date.parse(current.next_at)<=now||newMessage&&current.status==='waiting',nextAt:new Date(Math.min(Date.parse(current.next_at),now+60000)).toISOString()};
}
