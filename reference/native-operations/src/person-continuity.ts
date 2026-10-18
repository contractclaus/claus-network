import {recallConversation} from './social.js';

const validId=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v);
export async function xPersonContinuity(authorIds:string[],request=fetch){
 const ids=[...new Set(authorIds.filter(validId))].slice(0,6);
 if(!ids.length)return {available:true,people:[]};
 const secret=process.env.CLUB_AGENT_SECRET;
 if(!secret)return {available:false,people:[],reason:'club_not_connected'};
 try{
  const r=await request('https://claus.si/api/club-agent?view=person_continuity&xIds='+ids.join(','),{headers:{authorization:'Bearer '+secret},redirect:'error',signal:AbortSignal.timeout(6000)});
  if(!r.ok)throw Error('unavailable');const b=await r.json();
  if(b.scope!=='same_person_continuity'||b.available!==true||!Array.isArray(b.people))throw Error('invalid');
  return {available:true,people:b.people.filter((p:any)=>ids.includes(p.xUserId)&&p.verifiedLink===true).map((p:any)=>({xUserId:p.xUserId,verifiedLink:true,lastTelegramContactAt:typeof p.lastTelegramContactAt==='string'?p.lastTelegramContactAt:null,recentTelegramMessages:Number.isSafeInteger(p.recentTelegramMessages)&&p.recentTelegramMessages>=0?p.recentTelegramMessages:0})),
   instructionAuthority:false,meaning:'Exact wallet-confirmed X and Telegram account links, not owner authority. Only acknowledge Club contact when this X author refers to it and the timestamp supports it. Do not disclose membership unprompted, guess the private idea, or publish private content. Continue private detail in Telegram. Missing link evidence means unknown, not a different person.'};
 }catch{return {available:false,people:[],reason:'account_links_unavailable'};}
}

export async function clubPublicConversations(context:any,recall=recallConversation){
 const present=new Set((context?.events??[]).map((e:any)=>e.address));
 const members=(context?.transport?.members??[]).filter((p:any)=>present.has(p.address)&&validId(p.xUserId)).slice(0,6);
 return Promise.all(members.map(async(p:any)=>{
  try{return {clubAddress:p.address,xUserId:p.xUserId,xUsername:p.xUsername,verifiedLink:true,publicConversation:await recall({authorId:p.xUserId,limit:4}),instructionAuthority:false};}
  catch{return {clubAddress:p.address,xUserId:p.xUserId,available:false};}
 }));
}
