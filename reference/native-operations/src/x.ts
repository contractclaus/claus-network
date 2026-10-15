import {textPrefix} from './text.ts';
import { createHmac, randomBytes } from 'node:crypto';
import {unresolved,settleAction,ConfirmedFailure,sql} from './store.js';
import {xUserFields} from './twitter-policy.js';
import {providerRetryAt} from './reply-delivery.js';
import {ecosystemAccount} from './ecosystem.js';
import {productionLabDatabase} from './lab-db.js';
export const ownXId='2105791902952067072';
export const postFields='author_id,conversation_id,created_at,entities,in_reply_to_user_id,referenced_tweets,note_tweet,attachments,public_metrics';
export const xMediaFields='url,type,alt_text,width,height,preview_image_url';
export const mediaQuery='expansions=author_id,attachments.media_keys&media.fields='+xMediaFields;
export function withXMedia(post:any,includes:any) {
  const keys=post?.attachments?.media_keys??[];
  const images=(includes?.media??[]).filter((m:any)=>keys.includes(m.media_key)).flatMap((m:any)=>{
    const preview=['animated_gif','video'].includes(m.type);
    const url=m.type==='photo'?m.url:preview?m.preview_image_url:null;
    if(typeof url!=='string'||!url.startsWith('https://pbs.twimg.com/'))return [];
    return [{url,altText:m.alt_text??null,width:m.width,height:m.height,...(preview?{mediaType:m.type,previewOnly:true}:{})}];
  }).slice(0,4);
  return {...fullXPost(post),...(images.length?{images}:{})};
}
export function fullXPost(post:any) {
  if(typeof post?.note_tweet?.text!=='string')return post;
  const {note_tweet,...rest}=post;
  return {...rest,text:note_tweet.text,entities:note_tweet.entities??post.entities};
}
export function xAddressing(post:any) {
  const text=String(fullXPost(post)?.text??'');
  const prefix=text.match(/^(?:\s*@[a-z0-9_]+\b[\s,]*)+/i)?.[0]??'';
  const body=text.slice(prefix.length),mentions=prefix.match(/@[a-z0-9_]+/gi)??[];
  const reply=post.referenced_tweets?.some((r:any)=>r.type==='replied_to')||!!post.in_reply_to_user_id;
  const named=/@contractclaus\b/i.test(text)||post.entities?.mentions?.some((m:any)=>m.username?.toLowerCase()==='contractclaus');
  const kind=post.in_reply_to_user_id===ownXId?'reply_to_claus':
    /@contractclaus\b/i.test(body)||(!reply&&named)||(mentions.length===1&&mentions[0].toLowerCase()==='@contractclaus')?'explicit_mention':
    named?'carried_mention':'not_addressed';
  return {kind,body,replyToUserId:post.in_reply_to_user_id??null};
}
export function receivedClausInteraction(post:any) {
  return /^\d{1,19}$/.test(post?.id??'')&&/^\d{1,19}$/.test(post?.author_id??'')&&post.author_id!==ownXId&&
    !post.referenced_tweets?.some((r:any)=>r.type==='retweeted')&&
    xAddressing(post).kind!=='not_addressed';
}
export function directlyAddressesClaus(post:any) {
  return receivedClausInteraction(post)&&xAddressing(post).kind!=='carried_mention';
}
export function matchesPublishedPost(post:any,action:any) {
  const parent=post.referenced_tweets?.find((r:any)=>r.type==='replied_to')?.id;
  const hasMedia=action.input?.imageId||action.input?.gifId;
  const mediaKey=action.input?.gifMediaKey??action.input?.imageMediaKey;
  const expanded=(post.entities?.urls??[]).reduce((text:string,u:any)=>{
    if(typeof u.url!=='string'||typeof u.expanded_url!=='string')return text;
    if(hasMedia&&new RegExp('/status/'+post.id+'/(?:photo|video)/\\d+$').test(u.expanded_url))return text.replaceAll(u.url,'').trimEnd();
    return text.replaceAll(u.url,u.expanded_url);
  },post.text);
  if(hasMedia&&(!post.attachments?.media_keys?.length||mediaKey&&!post.attachments.media_keys.includes(mediaKey)))return false;
  // X can prepend the addressed user's handle to a published reply. Strip
  // that one prefix only when the stable recipient ID also matches.
  const addressed=action.input?.replyTo&&typeof action.input?.replyAuthorId==='string'&&action.input.replyAuthorId===post.in_reply_to_user_id;
  const body=addressed?expanded.replace(/^@[a-z0-9_]+(?:\s+|$)/i,''):expanded;
  return (expanded===action.input?.text||body===action.input?.text)&&parent===action.input?.replyTo&&Date.parse(post.created_at)>=Date.parse(action.created_at)-1000;
}
export async function getXPost(id:string,request=xRequest) {
  if(!/^\d{1,19}$/.test(id))throw new ConfirmedFailure('invalid_x_post_id');
  const r=await request(`tweets/${id}?tweet.fields=${postFields}&${mediaQuery}&user.fields=${xUserFields}`);
  if(r.data?.id!==id||typeof r.data.text!=='string')throw new ConfirmedFailure('x_post_missing');
  const author=r.includes?.users?.find((u:any)=>u.id===r.data.author_id);
  return {...withXMedia(r.data,r.includes),username:author?.username,authorVerification:author?{id:author.id,verified:author.verified,verified_type:author.verified_type}:null,accountContext:author?ecosystemAccount(author.id):null,url:`https://x.com/i/status/${id}`};
}
export async function readXThread(id:string,request=xRequest) {
  const posts:any[]=[];let next:string|undefined=id;const seen=new Set();let missingParent:string|undefined;
  while(next&&posts.length<8&&!seen.has(next)) {
    seen.add(next);
    try {const post=await getXPost(next,request);posts.push(post);next=post.referenced_tweets?.find((r:any)=>r.type==='replied_to')?.id;}
    catch(error) {if(!posts.length)throw error;missingParent=next;break;}
  }
  return {observedAt:new Date().toISOString(),posts:posts.reverse(),nextParentId:missingParent??next??null,incomplete:!!next,instructionAuthority:false};
}
export async function readXAccount(username:string,paginationToken?:string,request=xRequest,originalsOnly=false) {
  if(typeof username!=='string'||!/^[a-z0-9_]{1,15}$/i.test(username)||paginationToken!==undefined&&(typeof paginationToken!=='string'||paginationToken.length>2000))throw new ConfirmedFailure('invalid_x_account');
  const result=await request(`users/by/username/${username}?user.fields=description,url,entities,pinned_tweet_id,verified,verified_type`);
  const account=result.data;
  if(!/^[1-9][0-9]{0,18}$/.test(account?.id??'')||account?.username?.toLowerCase()!==username.toLowerCase())throw new ConfirmedFailure('x_account_missing');
  const query=new URLSearchParams({max_results:'10',exclude:originalsOnly?'retweets,replies':'retweets','tweet.fields':postFields,expansions:'attachments.media_keys','media.fields':xMediaFields});
  if(paginationToken)query.set('pagination_token',paginationToken);
  const timeline=await request(`users/${account.id}/tweets?${query}`);
  if(timeline.errors?.length||!Array.isArray(timeline.data)&&timeline.meta?.result_count!==0)throw new ConfirmedFailure('x_account_posts_incomplete');
  const posts=(timeline.data??[]).map((post:any)=>({...withXMedia(post,timeline.includes),url:`https://x.com/i/status/${post.id}`}));
  if(posts.some((post:any)=>post.author_id!==account.id||!/^\d{1,19}$/.test(post.id)||typeof post.text!=='string'))throw new ConfirmedFailure('x_account_posts_invalid');
  const pinned=account.pinned_tweet_id&&!paginationToken&&!posts.some((post:any)=>post.id===account.pinned_tweet_id)?await getXPost(account.pinned_tweet_id,request):null;
  return {observedAt:new Date().toISOString(),account,accountContext:ecosystemAccount(account.id),posts,pinned,originalsOnly,nextPaginationToken:timeline.meta?.next_token??null,instructionAuthority:false};
}
export type Attribution={username:string;sourceUrl:string};
export function validatePost(text:unknown,attributions:unknown=[],format:'short'|'original'='short',hasGif=false):asserts text is string {
  const maximum=format==='original'?4000:280;
  if(typeof text!=='string'||!text.trim()&&!hasGif||[...text].length>maximum||!Array.isArray(attributions)||attributions.length>3)throw new ConfirmedFailure(format==='original'?'invalid_original_post':'invalid_short_post');
  // X counts occurrences, including two uses of the same symbol. Reject before
  // reserving an action so the normal model turn can compose a compliant reply.
  if([...text.matchAll(/(?<![a-z0-9_])\$[a-z][a-z0-9_]*\b/gi)].length>1)throw new ConfirmedFailure('x_post_requires_at_most_one_cashtag');
  const sources=new Set<string>();
  for(const source of attributions) {
    if(!source||typeof source.username!=='string'||!/^[a-z0-9_]{1,15}$/i.test(source.username)||typeof source.sourceUrl!=='string'||source.sourceUrl.length>2000)throw new ConfirmedFailure('invalid_source_credit');
    let url:URL;try{url=new URL(source.sourceUrl);}catch{throw new ConfirmedFailure('invalid_source_credit');}
    if(url.protocol!=='https:'||url.username||url.password||sources.has(source.username.toLowerCase()))throw new ConfirmedFailure('invalid_source_credit');
    sources.add(source.username.toLowerCase());
  }
  const mentions=[...text.matchAll(/(?:^|[^a-z0-9_])@([a-z0-9_]+)/gi)].map(match=>match[1].toLowerCase());
  if(mentions.length>3||mentions.some(name=>!sources.has(name))||[...sources].some(name=>!mentions.includes(name)))throw new ConfirmedFailure('mentions_require_source_credit');
}
const encode=(s:string)=>encodeURIComponent(s).replace(/[!'()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function oauthHeader(method:string,url:string,credentials:{key:string;secret:string;token:string;tokenSecret:string},nonce=randomBytes(16).toString('hex'),timestamp=String(Math.floor(Date.now()/1000))) {
  const target=new URL(url);
  const oauth:Record<string,string>={oauth_consumer_key:credentials.key,oauth_nonce:nonce,oauth_signature_method:'HMAC-SHA1',oauth_timestamp:timestamp,oauth_token:credentials.token,oauth_version:'1.0'};
  const entries=[...Object.entries(oauth),...target.searchParams.entries()].map(([k,v])=>[encode(k),encode(v)]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:a[1]<b[1]?-1:a[1]>b[1]?1:0);
  const params=entries.map(([k,v])=>`${k}=${v}`).join('&');
  const base=[method.toUpperCase(),`${target.origin}${target.pathname}`,params].map(encode).join('&');
  oauth.oauth_signature=createHmac('sha1',`${encode(credentials.secret)}&${encode(credentials.tokenSecret)}`).update(base).digest('base64');
  return 'OAuth '+Object.entries(oauth).map(([k,v])=>`${encode(k)}="${encode(v)}"`).join(', ');
}
export function xReady() {return !!process.env.SOCIAL_URL&&!!process.env.SOCIAL_CLIENT_SECRET;}
function socialUrl(){const u=new URL(process.env.SOCIAL_URL!);if(u.protocol!=='https:'||u.hostname!=='claus-inference.vercel.app'||u.pathname!=='/'||u.search||u.hash||u.username||u.password)throw Error('x_broker_endpoint_invalid');return u.origin;}
export async function xRequest(path:string,method='GET',body?:unknown,request:typeof fetch=fetch,actionId?:string) {
 if(!xReady())throw Error('x_broker_unavailable');
 const payload={path,method,...(body?{body:path==='media/upload'?{media_category:(body as any).media_category}:body}:{}),...(actionId?{actionId}:{})};
 const r=await request(socialUrl()+'/api/social',{method:'POST',headers:{Authorization:'Bearer '+process.env.SOCIAL_CLIENT_SECRET,'Content-Type':'application/json'},body:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(30000)});
 const value=await r.json();if(!r.ok){if(value.definite===true)throw new ConfirmedFailure(value.error,value.retryAt);throw Error(value.error??'x_broker_unavailable');}return value.result;
}
export async function readSocialReceipt(id:string,request:typeof fetch=fetch){
 if(!xReady())return null;
 const r=await request(socialUrl()+'/api/social/receipts/'+encodeURIComponent(id),{headers:{Authorization:'Bearer '+process.env.SOCIAL_CLIENT_SECRET},redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('x_receipt_unavailable');return r.json();
}
// This is a positive-evidence window, not proof of non-delivery outside it.
// Posts take one bounded HTTP request; never match a similar post days later.
export function postReadbackWindow(action:any) {
  const at=Date.parse(action.created_at);
  if(!Number.isFinite(at))throw Error('x_readback_invalid_time');
  return {start:Math.floor((at-1000)/1000)*1000,end:Math.ceil((at+300000)/1000)*1000};
}
function readbackMatch(post:any,action:any) {
  const {start,end}=postReadbackWindow(action),at=Date.parse(post.created_at);
  return post.author_id===ownXId&&at>=start&&at<end&&
    (!action.input?.replyTo||typeof action.input.replyAuthorId==='string'&&post.in_reply_to_user_id===action.input.replyAuthorId)&&matchesPublishedPost(post,action);
}
function competingReadbackMatch(post:any,action:any) {
  // Missing historical recipient metadata must make us more conservative,
  // never let a prefixed reply appear uniquely attributable to another action.
  return matchesPublishedPost(post,{...action,input:{...action.input,replyAuthorId:action.input?.replyAuthorId??post.in_reply_to_user_id}});
}
export async function readPublishedAction(action:any,request=xRequest,clock=Date.now) {
  const {start,end}=postReadbackWindow(action),started=clock();
  if(started<end)return {state:'waiting' as const,nextAt:end+1000};
  const params=new URLSearchParams({max_results:'100',start_time:new Date(start).toISOString(),end_time:new Date(end).toISOString(),'tweet.fields':postFields});
  const matches=new Map<string,any>(),seen=new Map<string,string>(),tokens=new Set<string>();
  for(let page=0;page<3&&clock()-started<40000;page++) {
    const result=await request(`users/${ownXId}/tweets?${params}`);
    if(result.errors?.length||!Array.isArray(result.data)&&result.meta?.result_count!==0)throw Error('x_readback_incomplete');
    const rows=result.data??[];
    if(rows.length>100)throw Error('x_readback_incomplete');
    for(const raw of rows) {
      const p=fullXPost(raw);
      if(!/^[1-9][0-9]{0,18}$/.test(p?.id??'')||p.author_id!==ownXId||typeof p.text!=='string'||!Number.isFinite(Date.parse(p.created_at)))throw Error('x_readback_invalid_post');
      const signature=JSON.stringify([p.text,p.created_at,p.in_reply_to_user_id,p.referenced_tweets,p.entities,p.attachments]);
      if(seen.has(p.id)&&seen.get(p.id)!==signature)throw Error('x_readback_changed_post');
      seen.set(p.id,signature);
      if(readbackMatch(p,action))matches.set(p.id,p);
    }
    const next=result.meta?.next_token;
    if(next===undefined)return {state:'complete' as const,matches:[...matches.values()],pages:page+1};
    if(typeof next!=='string'||!next||next.length>2000||tokens.has(next))throw Error('x_readback_invalid_cursor');
    tokens.add(next);params.set('pagination_token',next);
  }
  return {state:'incomplete' as const};
}
type PostRecovery={verify:()=>Promise<any>;read:typeof xRequest;context:(a:any)=>Promise<any>;settle:(a:any,result:any,readback:boolean)=>Promise<boolean>;schedule:(a:any,value:any)=>Promise<void>};
export async function reconcilePostActions(actions:any[],d:PostRecovery,now=Date.now()) {
  const pending=actions.filter(a=>a.kind==='x_post');let inspected=0,verified=false;
  for(const original of pending) {
    if(original.progress?.result?.data?.id){await d.settle(original,original.progress.result,false);continue;}
    if(Date.parse(original.progress?.xReadback?.nextAt)>now||inspected>=1)continue;
    inspected++;
    let reason='no_unique_match',nextAt=now+(now-Date.parse(original.created_at)>86400000?86400000:3600000);
    try {
      const action=await d.context(original);
      if(!verified){const account=await d.verify();if(account.id!==ownXId||account.username.toLowerCase()!=='contractclaus')throw Error('x_account_mismatch');verified=true;}
      const r=await readPublishedAction(action,d.read);
      if(r.state==='waiting'){reason='window_open';nextAt=r.nextAt;}
      else if(r.state==='incomplete'){reason='incomplete';nextAt=now+900000;}
      else if(r.matches.length===1){
        const post=r.matches[0];
        const ambiguous=pending.some(a=>a.id!==action.id&&competingReadbackMatch(post,a));
        if(!ambiguous&&await d.settle(action,{data:post,reconciled:true},true))continue;
        reason='action_ambiguous';
      }
    }catch{reason='read_unavailable';nextAt=now+900000;}
    // Retain the original effect, delivery hold and all existing progress.
    await d.schedule(original,{checkedAt:new Date(now).toISOString(),nextAt:new Date(nextAt).toISOString(),reason});
  }
}
export async function reconcilePendingPosts() {
  const pending=await unresolved();
  // The separate sender may have the original receipt even when Native lost its response.
  for(const a of pending.filter(a=>a.kind==='x_post'&&Date.parse(a.created_at)>=Date.parse(process.env.SOCIAL_SOURCE_AFTER??'')).slice(-8)){try{const r=await readSocialReceipt(a.id);if(r?.status==='completed'&&/^\d{1,19}$/.test(r.result?.data?.id??'')){await settleAction(a.id,r.result);}else if(r?.status==='failed'&&r.failure?.definite===true){await settleAction(a.id,{error:r.failure.error,...(r.failure.retryAt?{retryAt:r.failure.retryAt}:{})},'failed');}}catch{/* Retain unknown delivery and the existing readback path. */}}
  await reconcilePostActions(await unresolved(),{
    verify:verifyX,read:xRequest,
    context:async action=>{
      const [source]=action.input?.replyTo?await sql()`SELECT author_id FROM claus_x_inbox WHERE post_id=${action.input.replyTo}`:[];
      const [image]=action.input?.imageId?await sql()`SELECT progress FROM claus_actions WHERE id=${action.input.imageId} AND kind='image'`:[];
      return {...action,input:{...action.input,replyAuthorId:action.input?.replyAuthorId??source?.author_id,imageMediaKey:image?.progress?.xMedia?.mediaKey}};
    },
    settle:async(action,result,readback)=>{
      if(!readback){await settleAction(action.id,result);return true;}
      return productionLabDatabase().transaction(async q=>{
        await q.query('SELECT pg_advisory_xact_lock(6041020)');
        const used=await q.query("SELECT id FROM claus_actions WHERE kind='x_post' AND status='completed' AND result->'data'->>'id'=$1 AND id<>$2 LIMIT 1",[result.data.id,action.id]);
        if(used.rows.length)return false;
        const others=await q.query("SELECT id,input,created_at FROM claus_actions WHERE kind='x_post' AND status NOT IN ('completed','failed') AND id<>$1",[action.id]);
        if(others.rows.some(a=>competingReadbackMatch(result.data,a)))return false;
        const saved=await q.query("UPDATE claus_actions SET status='completed',result=$2::jsonb,completed_at=now() WHERE id=$1 AND status NOT IN ('completed','failed') RETURNING id",[action.id,JSON.stringify(result)]);
        return saved.rows.length===1;
      });
    },
    schedule:async(a,value)=>{await sql()`UPDATE claus_actions SET progress=jsonb_set(COALESCE(progress,'{}'::jsonb),'{xReadback}',${JSON.stringify(value)}::jsonb) WHERE id=${a.id} AND status NOT IN ('completed','failed')`;}
  });
  await sql()`UPDATE claus_x_inbox i SET status='answered',reply_id=a.result->'data'->>'id',deferred_until=NULL FROM claus_actions a WHERE a.kind='x_post' AND a.status='completed' AND a.input->>'replyTo'=i.post_id AND a.result->'data'->>'id' IS NOT NULL AND i.status IN ('pending','retrying','delivery_blocked')`;
}
export async function verifyX(request=xRequest) {
  const result=await request('users/me');
  if(result.data?.id!==ownXId||result.data?.username?.toLowerCase()!=='contractclaus') throw new Error('x_account_mismatch');
  return {id:result.data.id,username:result.data.username};
}
