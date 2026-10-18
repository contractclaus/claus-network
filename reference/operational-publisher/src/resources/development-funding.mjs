import {digest} from './store.mjs';
const fail=c=>{throw Error('resource_development_'+c);};
// Deliberately above current iad1 CPU/memory prices; these are maximum
// authorizations, not invoices. Existing snapshot storage stays separate.
export function developmentMaximum(input){
 if(!input||!/^development:[A-Za-z0-9:_-]{1,220}$/.test(input.actionId??'')||![1,2,4,6,8].includes(input.vcpus)||!Number.isSafeInteger(input.seconds)||input.seconds<10||input.seconds>86340)fail('plan_invalid');
 return String(Math.ceil(input.vcpus*300000*(input.seconds+60)/3600)+10000);
}
export function developmentFunding({store,budget,request=fetch,now=Date.now}){
 let price;
 async function pricing(){
  if(price&&now()-price.observedAt<600000)return price;
  const url='https://vercel.com/docs/sandbox/pricing.md',r=await request(url,{redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok)fail('price_unavailable');
  const reader=r.body?.getReader();if(!reader)fail('price_unavailable');let bytes=0;const chunks=[];
  try{for(;;){const v=await reader.read();if(v.done)break;bytes+=v.value.length;if(bytes>100000)fail('price_response_too_large');chunks.push(v.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const text=Buffer.concat(chunks).toString('utf8'),cpu=/\| Sandbox Active CPU \|[^\n]*?\| \$([0-9.]+)\/hour \|/.exec(text),memory=/\| Sandbox Provisioned Memory \|[^\n]*?\| \$([0-9.]+)\/GB-hour \|/.exec(text);
  if(!cpu||!memory||![Number(cpu[1]),Number(memory[1])].every(x=>Number.isFinite(x)&&x>0)||Number(cpu[1])>0.2||Number(memory[1])>0.05)fail('price_changed');
  price={url,observedAt:now(),cpuUsdHour:Number(cpu[1]),memoryUsdGbHour:Number(memory[1]),sourceHash:digest(text),region:'iad1'};return price;
 }
 return async input=>{
  const maximum=developmentMaximum(input),id='act_'+digest(['development',input.actionId]).slice(0,24),existing=await store.get('development-funding',id);
  if(existing&&digest(existing.input)!==digest(input))fail('request_conflict');if(existing?.output)return existing.output;
  const observed=await pricing();const saved=(await store.put('development-funding',id,{input,maximum,price:observed,revision:1})).value;
  if(digest(saved.input)!==digest(input))fail('request_conflict');
  await budget('reserve',id,saved.maximum,'build');await budget('commit',id,saved.maximum,'build');
  const output={actionId:input.actionId,maximumMicroUsd:saved.maximum,price:saved.price,meaning:'Conservative CPU/memory execution authorization in the shared operating budget, not an actual invoice. Unknown execution does not release it. Persistent snapshots and account transfer billing remain separately observable provider costs.'};
  try{await store.change('development-funding',id,saved.revision,{...saved,revision:saved.revision+1,output});}catch{const current=await store.get('development-funding',id);if(!current?.output)throw Error('resource_development_funding_unconfirmed');return current.output;}
  return output;
 };
}
