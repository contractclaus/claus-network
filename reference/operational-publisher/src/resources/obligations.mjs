import {digest,sameValue} from './store.mjs';
const fail=c=>{throw Error('resource_obligation_'+c);};
const validText=(x,n)=>typeof x==='string'&&x.length>0&&x.length<=n&&!/-----BEGIN|Bearer\s|(?:password|secret|token)\s*[=:]\s*\S{8}/i.test(x);
export const obligationInputs={account_obligations:[],account_obligation_record:['name','expectedRevision','account','kind','scope','commitment','fixedMonthlyMicroUsd','nextReviewAt','renewalAt','control','evidence','observedAt','state']};
export function accountObligations({store,now=Date.now}){return {async call(operation,i){
 if(operation==='account_obligations'){let offset=0,items=[];do{const p=await store.list('account-obligation',offset);items.push(...p.items);offset=p.nextOffset;}while(offset!==null);return {items,observedAt:new Date(now()).toISOString(),due:items.filter(x=>x.state==='active'&&Date.parse(x.nextReviewAt)<=now()).map(x=>x.name),completeProviderInvoices:false,meaning:'Source-bound obligations register, not an invoice, payment or cancellation. Follow each actual provider control; never assume missing cost is zero or shared account cost is all Claus.'};}
 if(!/^[a-z][a-z0-9-]{1,80}$/.test(i.name??'')||!Number.isSafeInteger(i.expectedRevision)||i.expectedRevision<0||!['fixed','usage','prepaid','mixed'].includes(i.kind)||!['claus','shared-owner','owner-managed'].includes(i.scope)||!['active','ended'].includes(i.state))fail('definition_invalid');
 for(const k of ['account','commitment','control','evidence'])if(!validText(i[k],k==='account'?200:4000))fail('text_invalid');
 if(i.fixedMonthlyMicroUsd!==null&&!/^(0|[1-9][0-9]{0,12})$/.test(i.fixedMonthlyMicroUsd??''))fail('amount_invalid');
 for(const k of ['observedAt','nextReviewAt'])if(!Number.isFinite(Date.parse(i[k])))fail('date_invalid');
 if(Date.parse(i.observedAt)>now()+60000||Date.parse(i.nextReviewAt)<Date.parse(i.observedAt)||i.renewalAt!==null&&!Number.isFinite(Date.parse(i.renewalAt)))fail('date_invalid');
 const definition=Object.fromEntries(Object.entries(i).filter(([k])=>k!=='expectedRevision')),old=await store.get('account-obligation',i.name);
 if(old&&sameValue(old.definition,definition))return old;if((old?.revision??0)!==i.expectedRevision)fail('revision_conflict');
 const row={...definition,definition,revision:(old?.revision??0)+1,updatedAt:new Date(now()).toISOString(),accountingEffect:'none',providerStateAttestation:true};
 if(old)await store.change('account-obligation',i.name,old.revision,row);else if(!(await store.put('account-obligation',i.name,row)).created)fail('revision_conflict');
 await store.put('obligation-history',i.name+':'+row.revision,row);return row;
 }};}
