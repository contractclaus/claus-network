import {refreshCapitalCash} from './capital/budget.js';
import {creditSnapshot} from './credit-work-store.js';
import {CHAT_BUILDER_PROFILE,BOUNDED_BUILDER_PROFILE,SOL_BUILDER_PROFILE,SOL_EXTENDED_BUILDER_PROFILE,SOL_STREAM_BUILDER_PROFILE,SOL_MARKET_BUILDER_PROFILE,SOL_MARKET_XHIGH_BUILDER_PROFILE} from './builder-transport.js';
const builder=/^build_[a-f0-9]{24}:model:[1-3]$/;
const review=/^network-review:nr_[a-f0-9]{64}$/;
export const reviewCreditCandidate=(env,id)=>env.NETWORK_REVIEW_FRESH_RAIL==='credit_work'&&review.test(id);
export const workCandidate=(env,id)=>reviewCreditCandidate(env,id)||env.SURPLUS_CREDIT_SCOPE==='builder'&&env.BUILDER_FRESH_RAIL==='credit_work'&&builder.test(id)&&id!==env.SURPLUS_CREDIT_PILOT_ID;
export async function workAdmission(db,env,id,maximumMicroUsdc){
 const waiting=reason=>({id,maximumMicroUsdc,ready:false,rail:'surplus_credit',reason,retryAfterSeconds:60});
 if(!workCandidate(env,id)||env.SURPLUS_CREDIT_ENABLED!=='true')return waiting('credit_pilot_wait');
 if(!reviewCreditCandidate(env,id)&&env.BUILDER_CREDIT_PROFILE!==undefined&&![CHAT_BUILDER_PROFILE,BOUNDED_BUILDER_PROFILE,SOL_BUILDER_PROFILE,SOL_EXTENDED_BUILDER_PROFILE,SOL_STREAM_BUILDER_PROFILE,SOL_MARKET_BUILDER_PROFILE,SOL_MARKET_XHIGH_BUILDER_PROFILE].includes(env.BUILDER_CREDIT_PROFILE))return waiting('credit_profile_unavailable');
 if(!/^inf_[a-f0-9]{32}$/.test(env.SURPLUS_CREDIT_KEY??''))return waiting('credit_not_configured');
 const p=await creditSnapshot(db);
 if(!p||p.state!=='funded'||p.allocated!=='2000000'||p.key_id!==env.SURPLUS_CREDIT_KEY_ID||!/^0x[a-f0-9]{40}$/i.test(p.deposit_address??''))return waiting('credit_unavailable');
 if(maximumMicroUsdc!=='2000000')return waiting('credit_ceiling_mismatch');
 try{if(BigInt(env.MAX_INFERENCE_QUOTE_MICRO_USDC??'3000000')<2000000n)return waiting('credit_ceiling_mismatch');}
 catch{return waiting('credit_ceiling_mismatch');}
 await refreshCapitalCash(db);
 const [state]=await db`SELECT CASE WHEN capital_mode THEN claus_capital_available(false) ELSE ceiling-committed END AS remaining,EXISTS(SELECT 1 FROM claus_credit_work WHERE active AND active_until>now()) AS busy FROM claus_payment_budget WHERE id=true AND (capital_mode OR ceiling IN (100000000,500000000) OR ceiling BETWEEN 600000000 AND 1200000000)`;
 if(!state||BigInt(state.remaining)<2000000n)return waiting('credit_exhausted');
 if(state.busy)return waiting('credit_busy');
 const profile=reviewCreditCandidate(env,id)?null:env.BUILDER_CREDIT_PROFILE??null;
 const [cooldown]=await db`SELECT MAX((outcome->>'retryAtMs')::bigint)::text AS until FROM claus_credit_work
 WHERE (binding->'transport'->>'profile') IS NOT DISTINCT FROM ${profile}::text
 AND (outcome->>'retryAtMs')::bigint>EXTRACT(EPOCH FROM clock_timestamp())*1000`;
 if(cooldown?.until)return {...waiting('provider_cooldown'),retryAfterSeconds:Math.max(15,Math.min(3600,Math.ceil((Number(cooldown.until)-Date.now())/1000)))};
 return {id,maximumMicroUsdc,ready:true,rail:'surplus_credit'};
}
