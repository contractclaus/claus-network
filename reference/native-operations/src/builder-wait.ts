import {BUILD_LIMITS} from './builder-limits.js';
import {builderCommitment} from './builder-preflight.js';
const pending=new Set(['reserved','running','uncertain']);
// A date is a recheck, never a promise that an unknown charge clears at midnight.
export function modelCapacity(effects:any[],resetAt:string,now=Date.now(),scope='member'){
 const models=effects.filter(e=>e.kind==='model');
 const held=models.filter(e=>pending.has(e.status)).reduce((n,e)=>n+builderCommitment(e),0n);
 const used=models.filter(e=>e.today||pending.has(e.status)).reduce((n,e)=>n+builderCommitment(e),0n);
 const cap=BigInt(BUILD_LIMITS.dailyModelBudget),request=BigInt(BUILD_LIMITS.modelReservation);
 const ready=scope==='claus'||used+request<=cap,blockedByHolds=scope!=='claus'&&held+request>cap;
 return {ready,heldMicroUsdc:String(held),usedMicroUsdc:String(used),reason:ready?null:blockedByHolds?'unresolved_reservations':'daily_model_budget',
  eligibleAt:ready?new Date(now).toISOString():blockedByHolds?null:resetAt,
  nextCheckAt:ready?null:new Date(Math.min(now+15*60_000,blockedByHolds?Infinity:Date.parse(resetAt))).toISOString()};
}
export function receiptRecheckSeconds(effects:any[],now=Date.now(),scope='member'){
 const sent=effects.filter(e=>['running','uncertain'].includes(e.status));
 if(!sent.length)return 60;
 const newest=Math.max(...sent.map(e=>Date.parse(e.created_at)));
 const age=now-newest;
 return Number.isFinite(age)&&age>=86400_000?1800:Number.isFinite(age)&&age>=3600_000?900:60;
}
