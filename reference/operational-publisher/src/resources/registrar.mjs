import {randomUUID} from 'node:crypto';
import {digest,sameValue} from './store.mjs';
import {team} from './providers.mjs';
export const registrarInputs={registrar_status:[],registrar_search:['domains'],registrar_contact_schema:['domain'],registrar_contact_save:['contact','expectedRevision'],registrar_quote:['domain','years','kind'],registrar_buy:['quoteId','contactRevision','workId'],registrar_renew:['quoteId','workId'],registrar_order:['actionId'],registrar_disable_auto_renew:['domain','expectedRevision']};
const fail=c=>{throw Error('resource_registrar_'+c);};
const domain=v=>typeof v==='string'&&v.length<=253&&v===v.toLowerCase()&&v.split('.').length>=2&&v.split('.').every(x=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x));
const existing=v=>v==='claus.si'||v.endsWith('.claus.si');
export function managedRegistrar({store,providers,budget,seal,open,workStatus,now=Date.now}){
 const api=(p,o)=>providers.call('vercel',p,o),stamp=()=>new Date(now()).toISOString();
 async function order(id){
  const a=await store.get('action',id);if(!a||!['registrar_buy','registrar_renew'].includes(a.operation))fail('action_unknown');
  const receipt=await store.get('registrar-order',id);if(!receipt)return {actionId:id,state:'outcome_unknown',retry:false,maximumMicroUsd:a.prepared.maximum,next:'Keep the original request and contact the provider with its saved time/domain. Do not submit a second purchase.'};
  const v=await api('/v1/registrar/orders/'+encodeURIComponent(receipt.orderId));
  if(v.orderId!==receipt.orderId||!Array.isArray(v.domains)||v.domains.length!==1||v.domains[0].domainName!==a.prepared.quote.domain)fail('order_mismatch');
  const d=v.domains[0];
  if(v.status==='completed'&&d.status==='completed'){
   if(d.price!==a.prepared.quote.price||d.years!==a.prepared.quote.years)fail('price_or_term_changed');
   const prior=await store.get('registrar-domain',d.domainName);
   if(prior?.lastOrder!==receipt.orderId){const value={domain:d.domainName,owner:team,registrationAction:prior?.registrationAction??id,lastOrder:receipt.orderId,revision:(prior?.revision??0)+1,autoRenew:d.autoRenew??prior?.autoRenew??false,termYears:d.years,priceUsd:d.price,observedAt:stamp(),status:'registered'};if(prior)await store.change('registrar-domain',d.domainName,prior.revision,value);else await store.put('registrar-domain',d.domainName,value);}
  }
  return {actionId:id,orderId:receipt.orderId,state:v.status,domain:d.domainName,domainState:d.status,years:d.years,priceUsd:d.price,autoRenew:d.autoRenew??null,error:v.error?.code??d.error?.code??null,maximumMicroUsd:a.prepared.maximum,meaning:'Provider order status, not a tax invoice. Original authorization remains recorded. Existing claus.si renewal stays owner-managed.'};
 }
 return {async call(operation,input,requestId){
  if(operation==='registrar_status')return {owner:team,identity:await providers.identity('vercel'),contactRevision:(await store.get('registrar-contact','owner'))?.revision??null,domains:(await store.list('registrar-domain')).items,existingDomain:'claus.si remains owner-managed',meaning:'A working team identity does not prove acceptance of a future domain purchase.'};
  if(operation==='registrar_search'){if(!Array.isArray(input.domains)||!input.domains.length||input.domains.length>30||input.domains.some(x=>!domain(x)))fail('domains_invalid');return {observedAt:stamp(),...(await api('/v1/registrar/domains/search',{method:'POST',body:{domains:input.domains}}))};}
  if(operation==='registrar_contact_schema'){if(!domain(input.domain))fail('domain_invalid');return api('/v1/registrar/domains/'+encodeURIComponent(input.domain)+'/contact-info/schema');}
  if(operation==='registrar_contact_save'){
   const c=input.contact,keys=['firstName','lastName','email','phone','address1','address2','city','state','zip','country','companyName','fax','additional'];
   if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).some(k=>!keys.includes(k))||['firstName','lastName','email','phone','address1','city','zip','country'].some(k=>typeof c[k]!=='string'||!c[k].trim()||c[k].length>250)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||!/^\+[0-9. -]{6,24}$/.test(c.phone)||!c.email.includes('@')||!/^[A-Z]{2}$/.test(c.country)||JSON.stringify(c).length>5000)fail('real_owner_contact_required');
   const old=await store.get('registrar-contact','owner'),hash=digest(c);if(old?.hash===hash)return {revision:old.revision,stored:true,private:true};if((old?.revision??0)!==input.expectedRevision)fail('revision_conflict');
   const revision=input.expectedRevision+1,value={revision,hash,sealed:seal(JSON.stringify(c),'registrar-contact:'+revision),updatedAt:stamp()};
   if(old){await store.put('registrar-contact-version',String(old.revision),old);await store.change('registrar-contact','owner',old.revision,value);}else {const saved=await store.put('registrar-contact','owner',value);if(saved.value.hash!==hash)fail('revision_conflict');}
   return {revision,stored:true,private:true};
  }
  if(operation==='registrar_quote'){
   if(!domain(input.domain)||existing(input.domain)||!['purchase','renewal'].includes(input.kind)||!Number.isSafeInteger(input.years)||input.years<1||input.years>10)fail('quote_invalid');
   if(input.kind==='renewal'&&!(await store.get('registrar-domain',input.domain)))fail('unmanaged_domain');
   const v=await api('/v1/registrar/domains/'+encodeURIComponent(input.domain)+'/price?years='+input.years),price=input.kind==='purchase'?v.purchasePrice:v.renewalPrice;
   if(v.years!==input.years||typeof price!=='number'||!Number.isFinite(price)||price<=0)fail('price_unavailable');
   const q={id:'rq_'+randomUUID(),domain:input.domain,kind:input.kind,years:input.years,price,maximum:String(Math.ceil(price*1e6)),expiresAt:now()+300000,observedAt:stamp(),meaning:'Provider registration price in USD. Taxes or later recurring prices are not represented as a final invoice.'};await store.put('registrar-quote',q.id,q);return q;
  }
  if(operation==='registrar_order')return order(input.actionId);
  if(typeof requestId!=='string'||!requestId||requestId.length>200)fail('request_invalid');
  const id='act_'+digest(['owner',requestId]).slice(0,24),old=await store.get('action',id);if(old&&(old.operation!==operation||!sameValue(old.input,input)))fail('request_conflict');
  if(operation==='registrar_disable_auto_renew'){
   const d=await store.get('registrar-domain',input.domain);if(!d||existing(input.domain))fail('unmanaged_domain');if(d.revision!==input.expectedRevision&&!old)fail('revision_conflict');
   if(!old)await store.begin(id,operation,input,{domain:d.domain});if(old?.output)return old.output;
   if(!await store.dispatch(id))return {actionId:id,state:'outcome_unknown',retry:false};
   await api('/v1/registrar/domains/'+encodeURIComponent(d.domain)+'/auto-renew',{method:'PATCH',body:{autoRenew:false}});
   // An uncertain write remains uncertain; no fabricated readback.
   return store.complete(id,{actionId:id,requestedAutoRenew:false,domain:d.domain,providerAccepted:true});
  }
  if(!['registrar_buy','registrar_renew'].includes(operation))fail('operation_invalid');
  let a=old;
  if(!a){
   if(!/^nw_[a-z0-9_-]{1,80}$/.test(input.workId??'')||!['ready','working','waiting'].includes(await workStatus(input.workId)))fail('active_work_required');
   const q=await store.get('registrar-quote',input.quoteId);if(!q||q.expiresAt<=now()||q.kind!==(operation==='registrar_buy'?'purchase':'renewal'))fail('fresh_quote_required');
   const contact=operation==='registrar_buy'?await store.get('registrar-contact','owner'):null;if(operation==='registrar_buy'&&(!contact||contact.revision!==input.contactRevision))fail('real_owner_contact_required');
   a=(await store.begin(id,operation,input,{quote:q,maximum:q.maximum,contact,createdAt:stamp()})).row.result;
  }
  if(await store.get('registrar-order',id))return order(id);
  const q=a.prepared.quote,priorDomain=await store.get('registrar-domain',q.domain);
  const claim=await store.put('registrar-obligation',q.domain+':'+q.kind+':'+(q.kind==='renewal'?priorDomain?.lastOrder??'none':'initial'),{actionId:id});if(claim.value.actionId!==id)fail('original_obligation_requires_reconciliation');
  await budget('reserve',id,a.prepared.maximum,'service');
  if(await store.dispatch(id)){
   const q=a.prepared.quote,body={years:q.years,expectedPrice:q.price};if(operation==='registrar_buy'){body.autoRenew=false;body.contactInformation=JSON.parse(open(a.prepared.contact.sealed,'registrar-contact:'+a.prepared.contact.revision));}
   const v=await api('/v1/registrar/domains/'+encodeURIComponent(q.domain)+(operation==='registrar_buy'?'/buy':'/renew'),{method:'POST',body});
   if(typeof v.orderId!=='string'||!v.orderId)fail('order_response_unknown');await store.put('registrar-order',id,{orderId:v.orderId,domain:q.domain,createdAt:stamp()});
   await budget('commit',id,a.prepared.maximum,'service');
  }
  return order(id);
 }};
}
