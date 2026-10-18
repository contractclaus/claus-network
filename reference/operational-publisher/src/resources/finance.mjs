import {digest,sameValue} from './store.mjs';
import {providerRequest} from '../infrastructure/providers.mjs';
const fail=c=>{throw Error('resource_finance_'+c);};
const amount=v=>typeof v==='string'&&/^(0|[1-9][0-9]{0,12})$/.test(v);
const text=(v,max)=>typeof v==='string'&&!!v.trim()&&v.length<=max&&!/-----BEGIN|Bearer\s|(?:token|secret|password|api[-_]?key)\s*[=:]\s*\S{8}/i.test(v);
const kinds=new Set(['compute','storage','transfer','model','api','fixed']);
export const financeInputs={finance_overview:[],cost_plans:['offset'],cost_plan:['workId','projectId','expectedRevision','status','horizonHours','reserveMicroUsd','components','reason']};
export function managedFinance({store,workStatus,environment=process.env,request=fetch,now=Date.now}){
 async function payer(path){
  if(!environment.RESOURCE_MODEL_INFERENCE_SECRET)fail('payer_read_not_configured');
  return providerRequest(request,'https://claus-ecosystem-payments.vercel.app/api/'+path,environment.RESOURCE_MODEL_INFERENCE_SECRET);
 }
 const safe=async fn=>{try{return {available:true,value:await fn()};}catch{return {available:false,reason:'current_read_unavailable'};}};
 const getBook=async()=>await store.get('finance','project-plans')??{revision:0,plans:[]};
 const active=(p,at=now())=>p.status==='active'&&Date.parse(p.expiresAt)>at;
 const totals=(plans,at=now())=>plans.filter(p=>active(p,at)).reduce((v,p)=>v+BigInt(p.totalMicroUsd),0n);
 async function allAccounts(){const items=[];let offset=0;do{const page=await store.list('capability',offset);items.push(...page.items.filter(x=>x.name?.startsWith('account-')).map(x=>({name:x.name,provider:x.provider,description:x.description,billing:x.billing,recovery:x.recovery,limitations:x.limitations,evidence:x.evidence,updatedAt:x.updatedAt,referenceOnly:true})));offset=page.nextOffset;}while(offset!==null);return items;}
 async function runpod(){
  if(!environment.CLAUS_RUNPOD_API_KEY)fail('runpod_not_configured');
  const r=await providerRequest(request,'https://api.runpod.io/graphql',environment.CLAUS_RUNPOD_API_KEY,{method:'POST',body:{query:'query ClausFinanceBalance { myself { id clientBalance } }'}}),u=r.data?.myself;
  if(r.errors?.length||typeof u?.id!=='string'||!Number.isFinite(u.clientBalance)||Math.abs(u.clientBalance)>1000000)fail('runpod_response_invalid');
  return {accountId:u.id,balanceMicroUsd:String(Math.round(u.clientBalance*1000000)),observedAt:new Date(now()).toISOString(),meaning:'Provider credit, not revenue or operating-budget permission. Card reloads fund credit and are not counted again as consumption.'};
 }
 return {async call(operation,input){
  const book=await getBook();
  if(operation==='cost_plans'){
   const offset=input.offset??0;if(!Number.isSafeInteger(offset)||offset<0)fail('page_invalid');
   return {revision:book.revision,items:book.plans.slice(offset,offset+50).map(p=>({...p,activeNow:active(p)})),nextOffset:book.plans.length>offset+50?offset+50:null,activePlannedMicroUsd:totals(book.plans).toString(),meaning:'Planning allocations only. They do not reserve, charge, cancel, or enlarge the protected operating budget.'};
  }
  if(operation==='finance_overview'){
   const [resources,ledger,pod,costs,accounts,usage]=await Promise.all([safe(()=>payer('resources')),safe(()=>payer('operating-ledger')),safe(runpod),safe(()=>store.latestAccountCosts()),allAccounts(),safe(()=>store.latestProviderUsage())]);
   const v=resources.value?.capital,available=amount(v?.availableMicroUsdc)?BigInt(v.availableMicroUsdc):null,planned=totals(book.plans);
   return {version:1,observedAt:new Date(now()).toISOString(),resources,ledger,runpod:pod,accountBilling:costs,accounts,additionalAccountUsage:usage,planning:{revision:book.revision,activePlans:book.plans.filter(p=>active(p)).length,plannedMicroUsd:String(planned),unallocatedSnapshotMicroUsd:available===null?null:String(available>planned?available-planned:0n)},coverage:{completeAccountInvoices:false,combinedProviderConsumptionMicroUsd:null,reason:'Provider invoices, maximum authorizations and prepaid credit can overlap. Missing or delayed billing is unknown; no consolidated invoice total is invented.'},authorityChanged:false,meaning:'Read current operating permission, original exposure, provider credit, dated account costs and account billing/recovery references together. Only the existing protected per-action admission reserves funds. Planning allocations and provider cash are not additional income or authority.'};
  }
  if(operation!=='cost_plan')fail('operation_invalid');
  if(!/^nw_[a-z0-9_-]{1,80}$/.test(input.workId??'')||!/^prj_[a-zA-Z0-9_-]{1,100}$/.test(input.projectId??'')||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||!['active','closed'].includes(input.status)||!text(input.reason,1000))fail('plan_invalid');
  if(!Number.isSafeInteger(input.horizonHours)||input.horizonHours<1||input.horizonHours>720||!amount(input.reserveMicroUsd)||!Array.isArray(input.components)||input.components.length>60)fail('plan_invalid');
  for(const c of input.components)if(!c||Object.keys(c).some(k=>!['kind','maximumMicroUsd','basis'].includes(k))||!kinds.has(c.kind)||!amount(c.maximumMicroUsd)||!text(c.basis,500))fail('component_invalid');
  const fields={workId:input.workId,projectId:input.projectId,status:input.status,horizonHours:input.horizonHours,reserveMicroUsd:input.reserveMicroUsd,components:input.components,reason:input.reason},id='plan_'+digest([input.workId,input.projectId]).slice(0,24),old=book.plans.find(p=>p.id===id);
  if(old&&sameValue(old.definition,fields)&&(old.status==='closed'||active(old)))return {revision:book.revision,plan:old,unchanged:true,authorityChanged:false};
  if(book.revision!==input.expectedRevision)fail('revision_conflict');
  const state=await workStatus(input.workId);if(!state||input.status==='active'&&!['ready','working','waiting'].includes(state))fail('work_inactive');
  const total=BigInt(input.reserveMicroUsd)+input.components.reduce((n,c)=>n+BigInt(c.maximumMicroUsd),0n);
  let snapshot=null;
  if(input.status==='active'){
   if(!total)fail('empty_plan');
   const r=await payer('resources'),c=r.capital;
   if(c?.state!=='active'||!amount(c.availableMicroUsdc)||!amount(c.dailyMaximumMicroUsdc)||!amount(c.rolling30DayMaximumMicroUsdc))fail('budget_unavailable');
   const other=totals(book.plans.filter(p=>p.id!==id));
   if(total+other>BigInt(c.availableMicroUsdc)||total>BigInt(input.horizonHours<=24?c.dailyMaximumMicroUsdc:c.rolling30DayMaximumMicroUsdc))fail('plan_exceeds_current_headroom');
   snapshot={observedAt:r.observedAt,cashObservedAt:c.cashObservedAt,availableMicroUsd:c.availableMicroUsdc,otherPlannedMicroUsd:String(other),dailyMaximumMicroUsd:c.dailyMaximumMicroUsdc,rolling30DayMaximumMicroUsd:c.rolling30DayMaximumMicroUsdc};
  }
  const plan={id,...fields,definition:fields,totalMicroUsd:String(total),updatedAt:new Date(now()).toISOString(),expiresAt:new Date(now()+input.horizonHours*3600000).toISOString(),budgetSnapshot:snapshot,meaning:'Remaining cost estimate and planning allocation, not a paid commitment. Recalculate after actual spending or new quotes; each execution still passes the current protected budget.'};
  const plans=old?book.plans.map(p=>p.id===id?plan:p):[...book.plans,plan],next={revision:book.revision+1,plans};
  if(book.revision)await store.change('finance','project-plans',book.revision,next);else{const saved=await store.put('finance','project-plans',next);if(!saved.created)fail('revision_conflict');}
  await store.put('cost-plan-history',id+':'+next.revision,{revision:next.revision,plan});
  return {revision:next.revision,plan,authorityChanged:false};
 }};
}
