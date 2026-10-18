import {resourceStore} from '../resources/store.mjs';
import {openSecret} from '../resources/vault.mjs';
import {publisherRepository} from '../publisher/repository.js';
const fail=code=>{throw Error('infrastructure_secret_'+code);};
const kinds=new Set(['application','database-connection','broker-grant','external-service']);
export function runtimeBindings(work){
 const bindings=work.manifest?.secretBindings??[];
 if(!Array.isArray(bindings)||bindings.length>32)fail('bindings_invalid');
 const names=new Set();
 for(const b of bindings){
  if(!b||Object.keys(b).length!==3||typeof b.envName!=='string'||!/^[A-Z][A-Z0-9_]{1,100}$/.test(b.envName)||/^(?:NEXT_PUBLIC_|PUBLIC_|VITE_|VERCEL_|NODE_)/.test(b.envName)||!/^sec_[a-f0-9]{24}$/.test(b.secretId??'')||!Number.isSafeInteger(b.version)||b.version<1||names.has(b.envName))fail('bindings_invalid');
  names.add(b.envName);
 }
 return bindings;
}
export function runtimeSecrets({store,open=openSecret,now=Date.now,workStatus=id=>publisherRepository().workStatus(id)}={}){
 const data=()=>store??=resourceStore();
 async function head(binding){
  const s=await data().get('secret',binding.secretId);
  if(!s||!kinds.has(s.kind))return null;
  return s;
 }
 async function usable(s){return !!s&&s.status==='active'&&(!s.expiresAt||Date.parse(s.expiresAt)>now())&&(s.kind!=='broker-grant'||['ready','working','waiting'].includes(await workStatus(s.rules?.workId)));}
 async function load(work){
  const env={};
  for(const b of runtimeBindings(work)){
   const s=await head(b);if(!await usable(s)||s.version!==b.version)fail('inactive_or_changed');
   env[b.envName]=open(s.sealed,s.id+':'+s.version);
  }
  return env;
 }
 async function active(work){
  for(const b of runtimeBindings(work))if(!await usable(await head(b)))return false;
  return true;
 }
 async function redactor(work){
  const values=[];
  for(const b of runtimeBindings(work)){
   const s=await data().get('secret-version',b.secretId+':'+b.version);if(!s)fail('redaction_unavailable');
   const v=open(s.sealed,s.id+':'+s.version);values.push(v);
   try{const u=new URL(v);if(u.password)values.push(u.password,decodeURIComponent(u.password));}catch{}
  }
  const needles=[...new Set(values.flatMap(v=>[v,encodeURIComponent(v),JSON.stringify(v).slice(1,-1)]))].filter(v=>v.length>=4).sort((a,b)=>b.length-a.length);
  const redact=v=>typeof v==='string'?needles.reduce((s,n)=>s.split(n).join('[redacted]'),v):Array.isArray(v)?v.map(redact):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,redact(x)])):v;
  return redact;
 }
 async function error(work,cause){
  if(!runtimeBindings(work).length)return cause;
  let redact;try{redact=await redactor(work);}catch{return Error('infrastructure_secret_redaction_unavailable');}
  const clean=new Error(redact(cause?.message??'infrastructure_provider_error'));
  if(Number.isSafeInteger(cause?.status))clean.status=cause.status;
  if(cause?.retryAt)clean.retryAt=cause.retryAt;
  if(cause?.details)clean.details=redact(cause.details);
  return clean;
 }
 return {load,active,redactor,error};
}
