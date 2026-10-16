import {productionLabDatabase} from '../lab-db.js';
import {configuration,sql} from '../store.js';
import {replyExclusion} from '../twitter-policy.js';
import {blockedAccountReason} from '../account-blocklist.js';
import {receivedClausInteraction,getXPost} from '../x.js';
import {GotchiStore,type Source} from './store.js';
import {DAY} from './engine.js';

export const gotchiStore=()=>new GotchiStore(productionLabDatabase());
export const gotchiEnabled=(config:any)=>config.settings.enabled===true&&config.policy.rules.some((r:any)=>r.id==='gotchi-pilot'&&r.enabled);
const parameters={type:'object',properties:{postId:{type:'string'}},required:['postId'],additionalProperties:false};
export const gotchiDefinitions=[{type:'function',function:{name:'play_gotchi',description:'Process one real received X game command for its author. Supply only its postId, never a wallet, action or stats. A blue/gold verified or explicitly owner-allowed account can send @contractclaus adopt [name], feed, play, train, rest or status. Pause/resume must be @contractclaus gotchi pause or @contractclaus gotchi resume to avoid the platform consent commands. This creates one free virtual baby per X account. Care grows it at most once per UTC day; play/train/food shape personality. It never spends, mints NFTs or promises rewards. Explain the returned result briefly, with one relevant personality line if useful, in the ordinary reply to that same post. Use returned facts, never invent progress or claim a separate autonomous account. Do not send reminders, engagement requests or extra replies. Invalid prose is not consent: explain the command when asked, without executing it.',parameters}},
{type:'function',function:{name:'read_gotchi',description:'Read the actual baby belonging to the author of a current eligible public X message, for normal questions about their pet. Supply that message postId. No mutation, paid inference or wallet action. Use the returned personality and state to converse naturally; never invent remembered experiences, growth or rewards. Private Club messages cannot authorize this public tool.',parameters}}];

export function nativeSource(row:any,config:any,now=Date.now()):Source {
  const p=row?.post;
  if(!p||p.id!==row.post_id||p.author_id!==row.author_id||p.authorVerification?.id!==row.author_id||row.opted_out||replyExclusion(p,config.settings.replyXAuthorIds)||blockedAccountReason(p,config.settings.blockedXAccounts)||!receivedClausInteraction(p))throw Error('gotchi_source_unavailable');
  const created=Date.parse(p.created_at);
  return {id:p.id,authorId:row.author_id,text:p.text,createdAt:p.created_at,canStart:['pending','retrying'].includes(row.status)&&Number.isFinite(created)&&created<=now+60000&&now-created<=3*DAY};
}

export function gotchiExecutor(deps:{config:()=>Promise<any>;source:(id:string)=>Promise<any>;current:(id:string)=>Promise<any>;store:()=>GotchiStore}){
 return async(args:any,channel:'public'|'club'='public',readOnly=false)=>{
  if(channel!=='public')throw Error('gotchi_public_only');
  const config=await deps.config();if(!gotchiEnabled(config))throw Error('gotchi_disabled');
  if(!args||Object.keys(args).length!==1||typeof args.postId!=='string'||!/^[1-9][0-9]{0,18}$/.test(args.postId))throw Error('gotchi_invalid_arguments');
  const saved=await deps.source(args.postId);let source=nativeSource(saved,config);
  // A badge or source post may have changed since inbox ingestion. Fail closed
  // on a missing post, lost badge or changed author/text before any game write.
  const current=await deps.current(source.id);
  if(!current||current.text!==source.text||current.created_at!==source.createdAt)throw Error('gotchi_source_changed');
  nativeSource({...saved,post:current},config);
  source=nativeSource(await deps.source(args.postId),config);
  if(source.text!==current.text||source.authorId!==current.author_id)throw Error('gotchi_source_changed');
  if(readOnly){if(!source.canStart)throw Error('gotchi_source_expired');return {replyTo:source.id,pet:await deps.store().read(source.authorId),virtualOnly:true,nftMinting:false,tokenSpending:false};}
  return {replyTo:source.id,...await deps.store().act(source),virtualOnly:true,nftMinting:false,tokenSpending:false};
 };
}
export const playGotchi=gotchiExecutor({config:configuration,store:gotchiStore,current:getXPost,source:async id=>(await sql()`SELECT i.*,EXISTS(SELECT 1 FROM claus_x_optouts o WHERE o.author_id=i.author_id AND o.enabled) AS opted_out FROM claus_x_inbox i WHERE i.post_id=${id}`)[0]});
