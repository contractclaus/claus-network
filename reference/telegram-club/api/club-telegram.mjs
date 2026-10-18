import {withWebsiteContinuity} from '../lib/website-continuity.mjs';
import {createClubTelegram,telegramSecretMatches} from '../lib/club-telegram.mjs';
import {createClubStore} from '../lib/club-store.mjs';
import {createClubChain} from '../lib/club-chain.mjs';
import {notifyClubAgent} from '../lib/club-wake.mjs';
let service;
async function handler(req,res){
 res.setHeader('Cache-Control','private, no-store');res.setHeader('Content-Type','application/json');res.setHeader('X-Content-Type-Options','nosniff');
 const send=(status,value)=>{res.statusCode=status;res.end(JSON.stringify(value));};
 const cron=req.method==='GET'&&telegramSecretMatches(req.headers.authorization,'Bearer '+process.env.CRON_SECRET);
 const hook=req.method==='POST'&&telegramSecretMatches(req.headers['x-telegram-bot-api-secret-token'],process.env.CLUB_TELEGRAM_WEBHOOK_SECRET);
 if(!cron&&!hook)return send(403,{error:'forbidden'});
 try{
  service??=createClubTelegram({store:createClubStore(),chain:createClubChain(),wake:()=>notifyClubAgent()});
  if(cron)return send(200,await service.maintenance());
  let raw;if(req.body!==undefined)raw=typeof req.body==='string'?req.body:JSON.stringify(req.body);else{raw='';for await(const part of req){raw+=part;if(Buffer.byteLength(raw)>262144)return send(413,{error:'too_large'});}}
  if(Buffer.byteLength(raw)>262144)return send(413,{error:'too_large'});
  let update;try{update=JSON.parse(raw);}catch{return send(400,{error:'invalid_json'});}
  send(200,await service.receive(update));
 }catch(e){console.error('club_telegram_failed',String(e.code??'unavailable').slice(0,60));send(503,{error:'temporarily_unavailable'});}
}

export default withWebsiteContinuity(handler,{readSideEffects:true});
