import {createHash} from 'node:crypto';
export const PROFILE='claus-capital-v1';
export const MANDATE='a21b0e70568a888cdb95126b35c57f3b310ada00962a008ff76273ad13adc59c';
export const OWNER='0xbb145ca83272c3806d4ddc75ca1d5514789cf1c5';
export const PAYER='0xa46a89b5b3504c1c999696de8173ec9b2eb0a01a';
export const PRINCIPAL='0x59edf6152080e847e5ea15f9ae6a77c1f03c44f5';
export const USDC='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const ZERO='0x'+'0'.repeat(40),WORD_ZERO='0x'+'0'.repeat(64);
export const LIMITS=Object.freeze({investment:'100000000',perProject:'25000000',launch:'20000000000000000',perLaunch:'5000000000000000',ownerReserve:'900000000000000000'});
export const check=(ok,message)=>{if(!ok)throw Error('capital_'+message);};
export const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
export const addr=x=>typeof x==='string'&&/^0x[0-9a-f]{40}$/.test(x)&&x!==ZERO;
export const word=x=>typeof x==='string'&&/^0x[0-9a-f]{64}$/.test(x);
export const digest=x=>'sha256:'+createHash('sha256').update(canonical(x)).digest('hex');
export function canonical(v){
 if(v===null||typeof v==='boolean'||typeof v==='string')return JSON.stringify(v);
 if(typeof v==='number'&&Number.isSafeInteger(v)&&v>=0)return String(v);
 if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
 check(v&&Object.getPrototypeOf(v)===Object.prototype,'invalid_json');
 return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
}
export const keys=(v,names)=>check(v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===names.slice().sort().join(','),'fields');
const text=(v,max=4000)=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
const amount=(v,max)=>typeof v==='string'&&/^[1-9][0-9]{0,77}$/.test(v)&&BigInt(v)<=BigInt(max);
const hash=v=>typeof v==='string'&&/^sha256:[a-f0-9]{64}$/.test(v);
export const projectId=v=>typeof v==='string'&&/^prj_[A-Za-z0-9_-]{1,100}$/.test(v);
export function context(input){
 const v=typeof input==='string'?JSON.parse(input):input;
 keys(v,['version','action','terms','execution','delivery']);
 check(v.version===1&&['launch','fund','release'].includes(v.action),'action');
 const t=v.terms;
 keys(t,['projectId','counterparty','expiresAt','purpose','consideration','milestones','risks','exit']);
 check(projectId(t.projectId)&&addr(t.counterparty)&&Number.isSafeInteger(t.expiresAt)&&t.expiresAt>0,'terms');
 for(const k of ['purpose','consideration','exit'])check(text(t[k]),'terms');
 for(const k of ['milestones','risks'])check(Array.isArray(t[k])&&t[k].length>0&&t[k].length<=12&&t[k].every(x=>text(x,1500)),'terms');
 const e=v.execution;
 if(v.action==='launch'){
  check(v.delivery===null&&t.counterparty===OWNER,'launch_party');
  keys(e,['providerLaunchId','requestHash','artifactHash','calldata','calldataHash','valueWei','onchainLaunchId','components','protections']);
  check(/^[A-Za-z0-9_-]{16,128}$/.test(e.providerLaunchId)&&hash(e.requestHash)&&hash(e.artifactHash)&&word(e.calldataHash)&&word(e.onchainLaunchId),'launch_binding');
  check(typeof e.calldata==='string'&&/^0x(?:[0-9a-f]{2})+$/.test(e.calldata)&&e.calldata.length<=140000,'launch_calldata');
  check(typeof e.valueWei==='string'&&/^(0|[1-9][0-9]*)$/.test(e.valueWei)&&BigInt(e.valueWei)<BigInt(LIMITS.perLaunch),'launch_value');
  check(Array.isArray(e.components)&&e.components.length>=3&&e.components.length<=16,'launch_components');
  const indexes=new Set(),addresses=new Set();
  for(const c of e.components){
   keys(c,['targetIndex','address','runtimeHash','buildId','initCodeHash','constructorArgs']);
   check(Number.isSafeInteger(c.targetIndex)&&c.targetIndex>=0&&c.targetIndex<16&&!indexes.has(c.targetIndex)&&addr(c.address)&&!addresses.has(c.address)&&word(c.runtimeHash)&&hash(c.buildId)&&word(c.initCodeHash)&&/^0x(?:[0-9a-f]{2})*$/.test(c.constructorArgs)&&c.constructorArgs.length<=65538,'launch_component');
   indexes.add(c.targetIndex);addresses.add(c.address);
  }
  keys(e.protections,['freeTransfers','noBuySellPause','noBlacklist','maximumBuyTaxPips','maximumSellTaxPips','sourceReferences']);
  check(e.protections.freeTransfers===true&&e.protections.noBuySellPause===true&&e.protections.noBlacklist===true&&e.protections.maximumBuyTaxPips===150000&&e.protections.maximumSellTaxPips===150000&&Array.isArray(e.protections.sourceReferences)&&e.protections.sourceReferences.length>0&&e.protections.sourceReferences.every(x=>text(x,300)),'launch_protections');
 }else{
  keys(e,['escrow','amount','mode','deliveryToken','deliveryAmount','deliveryCodeHash']);
  check(addr(e.escrow)&&amount(e.amount,LIMITS.perProject)&&[0,1].includes(e.mode),'investment_terms');
  check(![OWNER,PAYER,PRINCIPAL].includes(t.counterparty),'related_party_investment');
  if(e.mode===0)check(e.deliveryToken===ZERO&&e.deliveryAmount==='0'&&e.deliveryCodeHash===WORD_ZERO,'milestone_terms');
  else check(addr(e.deliveryToken)&&e.deliveryToken!==USDC&&amount(e.deliveryAmount,2n**256n-1n)&&word(e.deliveryCodeHash)&&e.deliveryCodeHash!==WORD_ZERO,'allocation_terms');
  if(v.action==='fund')check(v.delivery===null,'delivery');
  else{keys(v.delivery,['hash','evidence']);check(e.mode===0&&word(v.delivery.hash)&&v.delivery.hash!==WORD_ZERO&&Array.isArray(v.delivery.evidence)&&v.delivery.evidence.length>0&&v.delivery.evidence.length<=12&&v.delivery.evidence.every(x=>text(x,6000)),'delivery');}
 }
 check(Buffer.byteLength(canonical(v))<=160000,'context_too_large');
 return JSON.parse(canonical(v));
}
export const termsHash=v=>'0x'+digest({terms:v.terms,execution:v.execution}).slice(7);
export const endorsement=v=>'CAPITAL_APPROVED:'+digest(v);
export const caseRef=v=>{keys(v,['projectId','caseId']);check(projectId(v.projectId)&&hash(v.caseId),'review_reference');return v;};
