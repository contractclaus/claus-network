import {hash} from './lab-schema.js';
import {configuration,sql} from './store.js';
import {blockedAccountReason} from './account-blocklist.js';
import {replyExclusion} from './twitter-policy.js';
import {clubFeedbackSource} from './club.js';

export type FeedbackKind='x'|'club_message'|'club_idea'|'self';
export type FeedbackSource={kind:FeedbackKind;id:string;authorId:string;contentHash:string;visibility:'public'|'private';text:string};
const initiative='Improve CLAUS usability, communication and nonfinancial product features within the owner-granted capabilities. Preserve official identity, links, addresses, privacy and all financial controls.';
type Readers={x:(id:string)=>Promise<any>;club:(kind:string,id:string)=>Promise<any>;config:()=>Promise<any>};
export function feedbackResolver(readers:Readers){return async(kind:unknown,id:unknown,channel:'public'|'club'='public'):Promise<FeedbackSource>=>{
 if(!['x','club_message','club_idea','self'].includes(String(kind))||typeof id!=='string')throw Error('feedback_source_required');
 if(kind==='self'){
  if(id!=='initiative')throw Error('feedback_source_invalid');
  return {kind,id,authorId:'claus',visibility:channel==='club'?'private':'public',text:initiative,contentHash:hash(initiative)};
 }
 if(kind==='x'){
  // Club arguments may contain private reasoning even when citing a public post.
  if(channel!=='public'||!/^[1-9][0-9]{0,18}$/.test(id))throw Error('feedback_channel_mismatch');
  const row=await readers.x(id),config=await readers.config();
  if(!row||row.post?.id!==id||blockedAccountReason({...row.post,author_id:row.author_id},config.settings.blockedXAccounts)||replyExclusion(row.post,config.settings.replyXAuthorIds))throw Error('feedback_source_unavailable');
  const text=row.post?.text;if(typeof text!=='string'||!text.trim()||text.length>16000||typeof row.author_id!=='string')throw Error('feedback_source_unavailable');
  return {kind:'x',id,authorId:row.author_id,visibility:'public',text,contentHash:hash({id,author:row.author_id,text})};
 }
 if(channel!=='club'||!/^[1-9][0-9]{0,15}$/.test(id))throw Error('feedback_channel_mismatch');
 const source=await readers.club(String(kind),id);
 if(source?.kind!==kind||source.id!==id||source.visibility!=='private'||typeof source.authorId!=='string'||!/^\d{1,19}$/.test(source.authorId)||typeof source.authorUsername!=='string'||!/^\w{1,15}$/.test(source.authorUsername)||typeof source.text!=='string'||!source.text.trim()||source.text.length>16000||source.contentHash!==hash({kind,id,authorId:source.authorId,text:source.text}))throw Error('feedback_source_unavailable');
 if(blockedAccountReason({author_id:source.authorId,username:source.authorUsername},(await readers.config()).settings.blockedXAccounts))throw Error('feedback_source_unavailable');
 // Strip transport-only membership metadata before the domain stores receive it.
 return {kind:source.kind,id:source.id,authorId:source.authorId,text:source.text,visibility:'private',contentHash:source.contentHash};
};}
export async function resolveFeedbackSource(kind:unknown,id:unknown,channel:'public'|'club'='public'){
 return feedbackResolver({config:configuration,club:clubFeedbackSource,x:async postId=>{
  const [row]=await sql()`SELECT i.post,i.author_id FROM claus_x_inbox i WHERE post_id=${postId}
  AND NOT EXISTS(SELECT 1 FROM claus_x_optouts o WHERE o.author_id=i.author_id AND o.enabled)`;
  return row;
 }})(kind,id,channel);
}

// A saved receipt remains replayable, but fresh work must still qualify against
// native records. Withdrawal, changed content or exclusion pauses new effects.
export async function feedbackSourceEligible(source:Pick<FeedbackSource,'kind'|'id'|'authorId'|'contentHash'|'visibility'>,resolve:typeof resolveFeedbackSource=resolveFeedbackSource){
 try{
  const current=await resolve(source.kind,source.id,source.visibility==='private'?'club':'public');
  return current.kind===source.kind&&current.id===source.id&&current.authorId===source.authorId&&current.contentHash===source.contentHash&&current.visibility===source.visibility;
 }catch{return false;}
}
