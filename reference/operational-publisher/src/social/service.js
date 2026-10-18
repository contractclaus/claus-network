import {outgoingActionRisk} from '../security/communication-policy.mjs';
import {createHash} from 'node:crypto';
import {requestShape,authorizePost,digest,SocialError} from './policy.js';
import {providerRequest} from './provider.js';
export function createSocial({repository,provider=providerRequest,after=()=>process.env.SOCIAL_SOURCE_AFTER}){
 const existing=(row,v)=>{
  if(row.input_hash!==digest(v))throw new SocialError('x_request_id_conflict',true);
  if(row.status==='completed')return row.response;
  if(row.status==='failed')throw new SocialError(row.response.error,true,row.response.retryAt);
  throw new SocialError('x_publication_requires_reconciliation');
 };
 return {
  async receipt(id){if(typeof id!=='string'||!/^[a-zA-Z0-9:_-]{1,160}$/.test(id))throw new SocialError('x_request_invalid',true);const r=await repository.get(id);return r?{status:r.status,...(r.status==='completed'?{result:r.response}:r.status==='failed'?{failure:r.response}:{})}:{status:'not_found'};},
  async call(input){
   const v=requestShape(input);
   if(v.method==='GET'){const c=await repository.config();if(!c?.policy?.capabilities?.xRead)throw new SocialError('x_read_disabled',true);return provider(v.path);}
   if(v.path==='media/upload'){
    const c=await repository.config();if(!c?.settings?.enabled||!c?.policy?.capabilities?.images||!c?.policy?.capabilities?.xPublish)throw new SocialError('x_media_disabled',true);
    const a=await repository.asset(v.actionId);
    if(!a||a.category!==v.body.media_category||typeof a.base64!=='string'||a.base64.length>6666668)throw new SocialError('x_media_invalid',true);
    const bytes=Buffer.from(a.base64,'base64');if(bytes.length>5000000||bytes.toString('base64')!==a.base64||createHash('sha256').update(bytes).digest('hex')!==a.sha256)throw new SocialError('x_media_invalid',true);
    return provider(v.path,v.method,{media:a.base64,media_category:a.category});
   }
   const old=await repository.get(v.actionId);if(old)return existing(old,v);
   const source=await repository.source(v.actionId);
   authorizePost(v,source,after());
   // Resolve actual provider identity; model-written attribution is not authority.
   if(v.body.reply){
    const target=await provider('tweets/'+v.body.reply.in_reply_to_tweet_id+'?tweet.fields=author_id,entities,note_tweet&expansions=author_id&user.fields=username');
    const author=target?.includes?.users?.find(u=>u.id===target.data?.author_id);
    if(target?.data?.id!==v.body.reply.in_reply_to_tweet_id||target.data.author_id!==source.action.input?.replyAuthorId||!author?.username)throw new SocialError('social_reply_identity_unavailable',true);
    const risk=outgoingActionRisk(v.body.text,{reply:true,recipient:author.username,participants:[...(target.data.entities?.mentions??[]),...(target.data.note_tweet?.entities?.mentions??[])].map(m=>m.username)});
    if(risk)throw new SocialError(risk,true);
   }
   const reserved=await repository.reserve(v.actionId,v);if(!reserved.created)return existing(reserved.row,v);
   let result;
   try{
    // Read policy again after the atomic effect reservation, before any publication.
    authorizePost(v,await repository.source(v.actionId),after());
    result=await provider(v.path,v.method,v.body);
    if(!/^\d{1,19}$/.test(result?.data?.id??''))throw new SocialError('x_post_response_missing');
   }catch(e){if(e instanceof SocialError&&e.definite)await repository.reject(v.actionId,e);throw e;}
   // A failed receipt write remains uncertain. Never resend the provider request.
   await repository.complete(v.actionId,result);return result;
  }
 };
}
