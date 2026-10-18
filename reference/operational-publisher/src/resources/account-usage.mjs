import {createHash} from 'node:crypto';
const fail=c=>{throw Error('resource_account_usage_'+c);};
const sha=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const number=(v)=>{if(typeof v!=='string'||!/^\d{1,24}(?:\.\d{1,9})?$/.test(v))fail('provider_shape');return v;};
const date=v=>{if(typeof v!=='string'||!Number.isFinite(Date.parse(v)))fail('provider_shape');return new Date(v).toISOString();};
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
export const accountUsageInputs={account_usage:['provider','view','from','to','cursor']};
export function accountUsage({store,environment=process.env,request=fetch,now=Date.now}){
 async function read(url,headers,body){
  const r=await request(url,{method:body?'POST':'GET',headers:{...headers,accept:'application/json',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(18000)});
  if(!r.ok){await r.body?.cancel().catch(()=>{});fail('provider_http_'+r.status);}
  const reader=r.body?.getReader();if(!reader)fail('provider_shape');let bytes=0;const parts=[];
  try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>2000000)fail('response_size');parts.push(part.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{fail('provider_shape');}
 }
 return async input=>{
  if(!['alchemy','composio'].includes(input.provider)||!['summary','application'].includes(input.view))fail('input_invalid');
  if(['from','to'].some(k=>input[k]!==undefined&&typeof input[k]!=='string'))fail('window_invalid');
  if(input.cursor!==undefined&&(typeof input.cursor!=='string'||!input.cursor||input.cursor.length>4096))fail('cursor_invalid');
  let requested={},value,source,coverage;
  if(input.provider==='composio'){
   if(input.view!=='summary'||input.cursor!==undefined)fail('input_invalid');
   const to=input.to===undefined?now():Date.parse(input.to),from=input.from===undefined?to-30*86400000:Date.parse(input.from);
   if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||from>=to||to>now()+1000||to-from>366*86400000)fail('window_invalid');
   const key=environment.RESOURCE_COMPOSIO_USAGE_TOKEN;if(!key)fail('not_configured');
   requested={from:new Date(from).toISOString(),to:new Date(to).toISOString()};
   source=await read('https://backend.composio.dev/api/v3.1/project/usage/summary',{'x-api-key':key},{from,to,entity_types:['tool_calls','sessions']});
   if(!object(source.entities))fail('provider_shape');const entities={};
   for(const name of ['tool_calls','sessions']){const e=source.entities[name];if(!e||e.unit!=='count'||!Number.isSafeInteger(e.event_count)||e.event_count<0)fail('provider_shape');entities[name]={unit:'count',totalQuantity:number(e.total_quantity),eventCount:e.event_count};}
   value={entities,instantCharge:source.instant_charge===undefined?null:number(String(source.instant_charge))};
   coverage={scope:'Existing Claus Composio project',billingInvoice:false,meaning:'Tool/session quantities and the provider instant-charge field. Included plan quotas, instant credits, third-party provider charges and invoices are different quantities.'};
  }else{
   const token=environment.RESOURCE_ALCHEMY_USAGE_TOKEN,app=environment.RESOURCE_ALCHEMY_APP_ID;
   if(!token||!/^\w{1,80}$/.test(app??''))fail('not_configured');
   const headers={authorization:'Bearer '+token};
   if(input.view==='summary'){
    if(input.from!==undefined||input.to!==undefined||input.cursor!==undefined)fail('input_invalid');
    source=await read('https://admin-api.alchemy.com/v1/usage/summary',headers);const s=source.data;
    if(!object(s)||!object(s.totals)||!object(s.usageLimit))fail('provider_shape');const totals={};
    for(const name of ['monthToDate','last7Days','last30Days']){const t=s.totals[name];if(!t||t.unit!=='ALCHEMY_COMPUTE_UNIT')fail('provider_shape');totals[name]={amount:number(t.amount),unit:t.unit,usd:number(t.usd)};}
    const u=s.usageLimit;if(!['USD','CU'].includes(u.unit)||!Number.isFinite(u.percentUsed)||u.percentUsed<0)fail('provider_shape');
    value={billingPeriod:{startTime:date(s.billingPeriod?.startTime),endTime:date(s.billingPeriod?.endTime)},totals,usageLimit:{unit:u.unit,limit:number(u.limit),used:number(u.used),remaining:number(u.remaining),percentUsed:u.percentUsed},dataThrough:date(s.freshness?.dataThrough)};
    coverage={scope:'Shared Alchemy account',billingInvoice:false,accountHeadroomTrusted:false,meaning:'Provider-reported API summary. History can be restricted by the plan and differ from full-cycle dashboard billing. Do not use this summary alone to infer full-cycle costs, remaining spend permission, or a safe account-limit increase. Other apps share the account.'};
   }else{
    const to=input.to===undefined?now():Date.parse(input.to),from=input.from===undefined?to-86400000:Date.parse(input.from);
    if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||from>=to||to>now()+1000||to-from>30*86400000)fail('window_invalid');
    requested={from:new Date(from).toISOString(),to:new Date(to).toISOString(),appId:app,cursor:input.cursor??null};
    const body={startTime:requested.from,endTime:requested.to,granularity:'day',products:['SUPERNODE_CU','SUPERNODE_ENHANCED_CU'],metrics:['amount'],filters:{appIds:[app]},groupBy:['app'],...(input.cursor?{cursor:input.cursor}:{})};
    source=await read('https://admin-api.alchemy.com/v1/usage/time-series',headers,body);const s=source.data,q=s?.query;
    if(!Array.isArray(s?.data)||s.data.length>10000||!object(q)||JSON.stringify(q.filters?.appIds)!==JSON.stringify([app])||q.granularity!=='day')fail('provider_scope');
    if(!Array.isArray(q.products)||q.products.length!==2||!body.products.every(p=>q.products.includes(p)))fail('provider_scope');
    if(s.cursor!==undefined&&s.cursor!==null&&(typeof s.cursor!=='string'||!s.cursor||s.cursor.length>4096))fail('provider_shape');
    const rows=s.data.map(r=>{if(r.unit!=='ALCHEMY_COMPUTE_UNIT'||r.dimensions?.app!==app||typeof r.isPartial!=='boolean')fail('provider_scope');return {startTime:date(r.startTime),endTime:date(r.endTime),isPartial:r.isPartial,appId:app,amount:number(r.amount),unit:r.unit};});
    value={appId:app,effectiveQuery:{from:date(q.startTime),to:date(q.endTime),granularity:'day',products:body.products},rows,nextCursor:s.cursor??null,dataThrough:date(s.freshness?.dataThrough)};
    coverage={scope:'Only configured Claus app '+app,billingInvoice:false,exactRollingWindow:false,historyMayBeClamped:true,pageComplete:!s.cursor,meaning:'Daily CU buckets can include the full boundary day, and plan history limits can omit older data. Follow nextCursor with the same window. No partial page or daily bucket sum is asserted as exact rolling cost.'};
   }
  }
  const result={provider:input.provider,view:input.view,observedAt:new Date(now()).toISOString(),requested,value,coverage,sourceSha256:sha(source),readOnlyProvider:true,budgetOrLimitsChanged:false};
  await store.put('account-usage-observation',sha(result),result);
  return result;
 };
}
