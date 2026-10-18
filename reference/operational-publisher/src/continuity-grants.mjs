import {resourceStore,digest} from './resources/store.mjs';
import {resourceBudget} from './resources/budget.mjs';
export async function maintainContinuityGrant({env=process.env,request=fetch,store=resourceStore(),budget=resourceBudget(),now=Date.now}={}){
 if(!env.CONTINUITY_URL||!env.CONTINUITY_OPERATOR_SECRET)return {state:'not_configured'};
 const endpoint=new URL(env.CONTINUITY_URL);
 if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.pathname!=='/'||!endpoint.hostname.endsWith('.proxy.runpod.net'))throw Error('continuity_origin_invalid');
 async function call(path,body){const r=await request(endpoint.origin+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+env.CONTINUITY_OPERATOR_SECRET,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(15000)});const v=await r.json();if(!r.ok)throw Error('continuity_grant_'+r.status);return v;}
 const status=await call('/v1/status');if(!Array.isArray(status.grants))throw Error('continuity_grants_missing');
 let remaining=0n;for(const g of status.grants){if(!/^\d+$/.test(String(g.amount_micro))||!/^\d+$/.test(String(g.allocated_micro)))throw Error('continuity_grant_shape');if(Date.parse(g.expires_at)>now()+3600000)remaining+=BigInt(g.amount_micro)-BigInt(g.allocated_micro);}
 if(remaining>=6000000n)return {state:'funded',remainingAuthorizedMicroUsd:remaining.toString()};
 const previous=status.grants[0]?.id??'initial';if(typeof previous!=='string'||previous.length>240)throw Error('continuity_anchor_invalid');
 const action='continuity-inference:'+previous+':'+Math.floor(now()/86400000),key=digest(action);
 const intent=(await store.put('continuity-grant',key,{action,id:'owned:sha256:'+digest(action)+':service:0',maximum:'20000000',expiresAt:new Date(now()+23*3600000).toISOString(),createdAt:new Date(now()).toISOString()})).value;
 if(Date.parse(intent.expiresAt)<=now()+20*60000)return {state:'original_grant_expired',id:intent.id};
 await budget('reserve',intent.action,intent.maximum,'service');
 const committed=await budget('commit',intent.action,intent.maximum,'service');
 if(committed.id!==intent.id||committed.state!=='committed'||committed.maximum!==intent.maximum)throw Error('continuity_commitment_mismatch');
 const receipt=await call('/v1/grants',{id:intent.id,amountMicroUsd:intent.maximum,expiresAt:intent.expiresAt,source:committed});
 if(receipt.id!==intent.id||receipt.recorded!==true)throw Error('continuity_import_uncertain');
 return {state:'funded',id:intent.id,maximumAuthorizedMicroUsd:intent.maximum,expiresAt:intent.expiresAt,actualProviderCost:null};
}
