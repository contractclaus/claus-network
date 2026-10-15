import {createHash} from 'node:crypto';
export const ownXId='2105791902952067072';
export const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export class SocialError extends Error {constructor(message,definite=false,retryAt){super(message);this.definite=definite;this.retryAt=retryAt;}}
export function requestShape(v){
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['path','method','body','actionId'].includes(k)))throw new SocialError('x_request_invalid',true);
 const {path,method='GET',body,actionId}=v;
 if(typeof path!=='string'||path.length>5000||/[\\#\u0000-\u0020]/.test(path)||path.startsWith('/')||path.split('?')[0].includes('%'))throw new SocialError('x_path_invalid',true);
 const url=new URL('https://api.x.com/2/'+path);
 if(url.origin!=='https://api.x.com'||url.pathname!=='/2/'+path.split('?')[0])throw new SocialError('x_path_invalid',true);
 const p=path.split('?')[0];
 const get=/^(users\/me|users\/by\/username\/[a-zA-Z0-9_]{1,15}|users\/[0-9]{1,19}\/(tweets|mentions)|tweets\/[0-9]{1,19}|tweets\/search\/recent)$/.test(p)||p==='media/upload'&&url.searchParams.get('command')==='STATUS'&&/^\d{1,19}$/.test(url.searchParams.get('media_id')??'');
 if(method==='GET'&&get&&body===undefined&&actionId===undefined)return {path,method};
 if(method!=='POST'||!body||typeof body!=='object'||Array.isArray(body))throw new SocialError('x_operation_forbidden',true);
 if(p==='media/upload'&&!url.search){
  if(Object.keys(body).join(',')!=='media_category'||!['tweet_image','tweet_gif'].includes(body.media_category)||typeof actionId!=='string'||!/^(image:[a-zA-Z0-9:_-]{1,160}|gif:gif_[a-f0-9]{64})$/.test(actionId))throw new SocialError('x_media_invalid',true);
  return {path,method,body,actionId};
 }
 if(p!=='tweets'||url.search||typeof actionId!=='string'||!/^[a-zA-Z0-9:_-]{1,160}$/.test(actionId)||Object.keys(body).some(k=>!['text','reply','media'].includes(k)))throw new SocialError('x_operation_forbidden',true);
 if(typeof body.text!=='string'||[...body.text].length>4000||!body.text.trim()&&!body.media)throw new SocialError('x_post_invalid',true);
 if(body.reply&&(Object.keys(body.reply).join(',')!=='in_reply_to_tweet_id'||!/^\d{1,19}$/.test(body.reply.in_reply_to_tweet_id)))throw new SocialError('x_reply_invalid',true);
 if(body.media&&(Object.keys(body.media).join(',')!=='media_ids'||!Array.isArray(body.media.media_ids)||body.media.media_ids.length!==1||!/^\d{1,19}$/.test(body.media.media_ids[0])))throw new SocialError('x_media_invalid',true);
 return {path,method,body,actionId};
}
export function authorizePost(v,source,after){
 const a=source?.action,c=source?.config;
 if(!a||a.status!=='pending'||!Number.isFinite(Date.parse(after))||Date.parse(a.created_at)<Date.parse(after))throw new SocialError('x_original_action_required',true);
 if(a.input?.text!==v.body.text||(a.input?.replyTo??null)!==(v.body.reply?.in_reply_to_tweet_id??null))throw new SocialError('x_original_action_conflict',true);
 if(!c?.settings?.enabled||!c.policy?.capabilities?.xPublish)throw new SocialError('publication_disabled',true);
 const rules=c.policy?.rules??[];
 if(rules.some(r=>r.enabled&&(r.id==='private-experiment'||!v.body.reply&&r.id==='original-posts-paused')))throw new SocialError('publication_disabled',true);
 if(v.body.reply&&(!c.policy.capabilities.xReply||source.optedOut))throw new SocialError('publication_disabled',true);
 if(v.body.reply&&c.settings.blockedXAccounts?.some(x=>x.id===a.input?.replyAuthorId))throw new SocialError('owner_account_blocked',true);
 if(v.body.media&&(!c.policy.capabilities.images||!a.input?.imageId&&!a.input?.gifId))throw new SocialError('x_media_invalid',true);
}
