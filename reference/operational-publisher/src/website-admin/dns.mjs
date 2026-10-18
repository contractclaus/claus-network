import {isIP} from 'node:net';
import {isDeepStrictEqual} from 'node:util';

export const DNS_TYPES=Object.freeze(['A','AAAA','CNAME','TXT','MX','CAA','NS','SRV','HTTPS','SVCB']);
const fail=()=>{throw Error('website_dns_plan_invalid');};
const integer=(v,max=65535)=>Number.isSafeInteger(v)&&v>=0&&v<=max;
const text=(v,max=4096)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
export function dnsName(value,own=true){
 if(!text(value,254))fail();
 const name=value.toLowerCase().replace(/\.$/,'');
 const labels=name.split('.');
 if(name.length>253||labels.some((label,i)=>label.length>63||!(label==='*'&&i===0&&own)&&!/^[_a-z0-9](?:[_a-z0-9-]*[_a-z0-9])?$/.test(label)))fail();
 if(own&&name!=='claus.si'&&!name.endsWith('.claus.si'))throw Error('website_domain_outside_owner_scope');
 return name;
}
function structuredData(type,value){
 if(!value||Array.isArray(value)||typeof value!=='object')fail();
 const keys=type==='CAA'?['flags','tag','value']:type==='SRV'?['priority','weight','port','target']:['priority','target','value'];
 if(Object.keys(value).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(value,k)))fail();
 if(type==='CAA'){
  if(!integer(value.flags,255)||!text(value.tag,32)||!/^[a-z0-9]+$/i.test(value.tag)||!text(value.value))fail();
  return {flags:value.flags,tag:value.tag.toLowerCase(),value:value.value};
 }
 if(!integer(value.priority))fail();
 const target=value.target==='.'?'.':dnsName(value.target,false);
 if(type==='SRV'){
  if(!integer(value.weight)||!integer(value.port))fail();
  return {priority:value.priority,weight:value.weight,port:value.port,target};
 }
 if(typeof value.value!=='string'||value.value.length>4096||/[\x00-\x1f\x7f]/.test(value.value))fail();
 return {priority:value.priority,target,value:value.value};
}
export function dnsBody(plan){
 const name=dnsName(plan.name);
 if(!DNS_TYPES.includes(plan.type)||!['set','remove'].includes(plan.operation))fail();
 if(plan.id!==undefined&&!/^[a-f0-9]{32}$/.test(plan.id))throw Error('website_dns_id_invalid');
 if(plan.operation==='remove'){
  if(!plan.id)throw Error('website_dns_id_required');
  return {name,type:plan.type};
 }
 if(!Number.isSafeInteger(plan.ttl)||plan.ttl!==1&&(plan.ttl<60||plan.ttl>86400)||plan.proxied!==undefined&&typeof plan.proxied!=='boolean')fail();
 if(plan.proxied===true&&!['A','AAAA','CNAME'].includes(plan.type))fail();
 const body={name,type:plan.type,ttl:plan.proxied===true?1:plan.ttl,proxied:plan.proxied===true};
 if(['CAA','SRV','HTTPS','SVCB'].includes(plan.type)&&plan.data!==undefined){
  if(plan.content!==undefined||plan.priority!==undefined)fail();
  return {...body,data:structuredData(plan.type,plan.data)};
 }
 if(plan.data!==undefined||!text(plan.content))fail();
 if(plan.type==='A'&&isIP(plan.content)!==4||plan.type==='AAAA'&&isIP(plan.content)!==6)fail();
 body.content=['CNAME','MX','NS'].includes(plan.type)?(plan.content==='.'&&plan.type==='MX'?'.':dnsName(plan.content,false)):plan.content;
 if(plan.type==='MX'){
  if(!integer(plan.priority))fail();body.priority=plan.priority;
 }else if(plan.priority!==undefined)fail();
 return body;
}
export function dnsView(row){
 return {id:row.id,name:row.name,type:row.type,content:row.content,ttl:row.ttl,proxied:row.proxied??false,...(row.type==='MX'?{priority:row.priority}:{}),...(row.data?{data:row.data}:{})};
}
export function dnsMatches(plan,row){
 if(!row)return false;
 const expected=dnsBody(plan);
 if(row.name.toLowerCase().replace(/\.$/,'')!==expected.name||row.type!==expected.type||row.ttl!==expected.ttl||(row.proxied??false)!==expected.proxied)return false;
 if(expected.data){
  try{return isDeepStrictEqual(structuredData(row.type,row.data),expected.data);}catch{return false;}
 }
 const actual=['CNAME','MX','NS'].includes(row.type)?row.content?.toLowerCase().replace(/(?<!^)\.$/,''):row.content;
 return actual===expected.content&&(row.type!=='MX'||row.priority===expected.priority);
}
