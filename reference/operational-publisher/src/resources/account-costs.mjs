import {createHash} from 'node:crypto';
import {team,ResourceProviderError,retryTime} from './providers.mjs';
const day=86400000;
const fail=code=>{throw Error('resource_cost_'+code);};
const money=value=>Math.round(value*1e6)/1e6;
export const costInputs={account_costs:['provider','from','to','projectId']};
export function accountCosts({store,request=fetch,env=process.env,now=Date.now}){
 return async input=>{
  if(input.provider!=='vercel')fail('provider_unsupported');
  const end=input.to===undefined?now():Date.parse(input.to),start=input.from===undefined?end-31*day:Date.parse(input.from);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end>now()+1000||end-start>31*day||start<now()-366*day)fail('period_invalid');
  if(input.projectId!==undefined&&!/^prj_[A-Za-z0-9]{1,100}$/.test(input.projectId))fail('project_invalid');
  const token=env.RESOURCE_VERCEL_TOKEN;if(!token)fail('team_access_missing');
  const from=new Date(start).toISOString(),to=new Date(end).toISOString();
  const response=await request('https://api.vercel.com/v1/billing/charges?'+new URLSearchParams({teamId:team,from,to}),{headers:{authorization:'Bearer '+token,accept:'application/x-ndjson'},redirect:'error',signal:AbortSignal.timeout(60000)});
  if(!response.ok){void response.body?.cancel().catch(()=>{});throw new ResourceProviderError(response.status,'vercel',retryTime(response.headers.get('retry-after'),now()));}
  const totals={billed:0,effective:0},groups={services:new Map(),projects:new Map(),days:new Map()},hash=createHash('sha256');
  let count=0,selected=0,bytes=0,remaining='',dataFrom=Infinity,dataThrough=-Infinity;
  const decoder=new TextDecoder('utf-8',{fatal:true});
  function add(map,key,row){
   if(!map.has(key)){if(map.size>=2000)fail('group_limit');map.set(key,{key,billed:0,effective:0});}
   const v=map.get(key);v.billed+=row.BilledCost;v.effective+=row.EffectiveCost;
  }
  function line(text){
   if(!text.trim())return;if(text.length>65536||++count>250000)fail('row_limit');
   let r;try{r=JSON.parse(text);}catch{fail('response_invalid');}
   if(r.BillingCurrency!=='USD'||r.ServiceProviderName!=='Vercel'||typeof r.ServiceName!=='string'||r.ServiceName.length>160||![r.BilledCost,r.EffectiveCost].every(v=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=1e9))fail('response_invalid');
   const a=Date.parse(r.ChargePeriodStart),b=Date.parse(r.ChargePeriodEnd);
   if(!Number.isFinite(a)||!Number.isFinite(b)||a>=b||a<start-day||b>end+day)fail('response_period_invalid');
   dataFrom=Math.min(dataFrom,a);dataThrough=Math.max(dataThrough,b);
   const project=r.Tags?.ProjectId??null;
   if(project!==null&&(typeof project!=='string'||!/^prj_[A-Za-z0-9]{1,100}$/.test(project)))fail('response_project_invalid');
   if(input.projectId&&input.projectId!==project)return;
   selected++;totals.billed+=r.BilledCost;totals.effective+=r.EffectiveCost;
   add(groups.services,r.ServiceName,r);add(groups.projects,project??'team-unallocated',r);add(groups.days,r.ChargePeriodStart,r);
  }
  try{
   for await(const chunk of response.body){
    bytes+=chunk.length;if(bytes>64*1024*1024)fail('response_limit');hash.update(chunk);remaining+=decoder.decode(chunk,{stream:true});
    let index;while((index=remaining.indexOf('\n'))!==-1){line(remaining.slice(0,index));remaining=remaining.slice(index+1);}
    if(remaining.length>65536)fail('row_limit');
   }
   remaining+=decoder.decode();line(remaining);
  }catch(e){if(String(e.message).startsWith('resource_'))throw e;fail('stream_incomplete');}
  const clean=map=>[...map.values()].map(v=>({...v,billed:money(v.billed),effective:money(v.effective)})).sort((a,b)=>b.billed-a.billed||a.key.localeCompare(b.key));
  const observedAt=new Date(now()).toISOString(),receipt=hash.digest('hex');
  const result={version:1,provider:'vercel',account:team,requested:{from,to,projectId:input.projectId??null},observedAt,currency:'USD',source:'/v1/billing/charges',sourceSha256:receipt,rows:count,selectedRows:selected,sourceBytes:bytes,dataFrom:count?new Date(dataFrom).toISOString():null,dataThrough:count?new Date(dataThrough).toISOString():null,unreportedInterval:count&&dataThrough>=end?null:{from:count?new Date(dataThrough).toISOString():from,to},totals:{billed:money(totals.billed),effective:money(totals.effective),appliedCredits:money(totals.effective-totals.billed)},services:clean(groups.services),projects:clean(groups.projects),days:clean(groups.days),meaning:'Authenticated provider billing export with daily granularity and reporting delay. Billed is after provider credits; effective is before those credits. Fixed fees are daily allocations and may differ from the full next invoice. Missing recent periods are not zero cost. Project-filtered results exclude team-unallocated fees. This read does not create a payment, release a hold, import costs into the operating ledger or enforce a provider spend cap.'};
  await store.put('account-cost-observation',receipt+':'+(input.projectId??'all'),result);
  return result;
 };
}
