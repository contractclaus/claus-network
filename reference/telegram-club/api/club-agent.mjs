import {createTelegramMedia} from '../lib/telegram-media.mjs';
import {createTelegramClient} from '../lib/club-telegram.mjs';
import {withWebsiteContinuity} from '../lib/website-continuity.mjs';
import {createClubTelegram} from '../lib/club-telegram.mjs';
import {timingSafeEqual} from 'node:crypto';
import {createClubStore} from '../lib/club-store.mjs';
import {createClubChain} from '../lib/club-chain.mjs';
import {createClubResearch} from '../lib/club-research.mjs';
import {createClubAgent} from '../lib/club-agent.mjs';
import {ClubError} from '../lib/club-common.mjs';
export function createClubAgentHandler({service,secret,research,media}){
 return async(req,res)=>{
  res.setHeader('Cache-Control','private, no-store');res.setHeader('Content-Type','application/json');res.setHeader('X-Robots-Tag','noindex, nofollow');
  const send=(status,value)=>{res.statusCode=status;res.end(JSON.stringify(value));};
  const wanted='Bearer '+secret,actual=req.headers.authorization;
  if(!secret||secret.length<32||typeof actual!=='string'||Buffer.byteLength(actual)!==Buffer.byteLength(wanted)||!timingSafeEqual(Buffer.from(actual),Buffer.from(wanted)))return send(401,{error:'unauthorized'});
  try{
   const url=new URL(req.url,'https://claus.si');if(req.method==='GET'){if(url.searchParams.get('view')==='media')return send(200,await media.read(url.searchParams.get('id')));if(url.searchParams.get('view')==='person_continuity')return send(200,await service.personContinuity(url.searchParams.get('xIds')));if(url.searchParams.get('view')==='feedback')return send(200,await service.feedback(url.searchParams.get('kind'),url.searchParams.get('id')));if(url.searchParams.get('view')==='topic')return send(200,await service.topic(url.searchParams.get('id'),url.searchParams.get('before')));if(url.searchParams.get('view')==='topics')return send(200,await service.topics(url.searchParams.get('before')));if(url.searchParams.get('view')==='members')return send(200,await service.members());if(url.searchParams.get('view')==='moderation')return send(200,await service.moderation());if(url.searchParams.get('view')==='poll')return send(200,await service.poll(url.searchParams.get('id'),url.searchParams.get('voterUsername')));if(url.searchParams.get('view')==='research')return send(200,await research.pending());if(url.searchParams.get('view')==='idea')return send(200,await service.idea(url.searchParams.get('id')));if(url.searchParams.get('view')==='thread')return send(200,await service.thread(url.searchParams.get('id')));if(url.searchParams.get('view')==='receipt')return send(200,await service.receipt(url.searchParams.get('id')));if(url.searchParams.get('view')==='status')return send(200,await service.status());return send(200,await service.context());}
   if(req.method!=='POST')return send(405,{error:'method_not_allowed'});
   let raw='';if(req.body!==undefined)raw=typeof req.body==='string'?req.body:JSON.stringify(req.body);else for await(const b of req){raw+=b;if(Buffer.byteLength(raw)>3000000)return send(413,{error:'too_large'});}
   if(Buffer.byteLength(raw)>3000000)return send(413,{error:'too_large'});let body;try{body=JSON.parse(raw);}catch{return send(400,{error:'invalid_json'});}
   if(body.action==='research_sync')return send(200,await research.sync(body.input));
   if(body.action==='presence')return send(200,await service.presence(body.input));
   return send(200,await service.write(req.headers['idempotency-key'],body.action,body.input));
  }catch(e){if(e instanceof ClubError)return send(e.status,{error:e.code});if(e.code==='P0001'&&/^(club_agent_|club_muted|club_slowmode|club_too_fast)/.test(e.message))return send(409,{error:e.message});return send(503,{error:'club_agent_unavailable'});}
 };
}
let handler;
async function main(req,res){try{handler??=createClubAgentHandler({media:createTelegramMedia({sql:createClubStore().sql,call:createTelegramClient()}),service:createClubAgent({store:createClubStore(),chain:createClubChain(),telegram:process.env.CLUB_TELEGRAM_CHAT_ENABLED==='true'?createClubTelegram({store:createClubStore(),chain:createClubChain()}):undefined}),secret:process.env.CLUB_AGENT_SECRET,research:createClubResearch(createClubStore())});await handler(req,res);}catch{res.statusCode=503;res.setHeader('Cache-Control','no-store');res.end('{"error":"club_agent_unavailable"}');}}

export default withWebsiteContinuity(main,{readSideEffects:true});
