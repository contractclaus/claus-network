import {randomUUID} from 'node:crypto';

const SYSTEM_CODES=new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_SOCKET']);
const SQL_CODES=new Set(['08000','08001','08003','08004','08006','08007','08P01','22001','22003','22007','22023','22P02','23502','23503','23505','23514','25006','25P02','40001','40P01','42501','42601','42703','42804','42883','42P01','42P07','53300','53400','55000','55P03','57014','57P01','57P02','57P03','58000','58030']);
const NAMES=new Set(['Error','TypeError','RangeError','SyntaxError','AggregateError','AbortError','TimeoutError']);
const ID=/^crq_[a-f0-9]{32}$/;

export function safeFault(error,knownCode=null){
 const frames=String(error?.stack??'').split('\n').slice(1).flatMap(line=>{
  const m=line.match(/\b((?:api|runtime|src|interfaces|adapters)\/[A-Za-z0-9_./-]+\.(?:mjs|cjs|js|ts)):(\d+):(\d+)/);
  return m&&!m[1].split('/').includes('..')?[{file:m[1],line:Number(m[2]),column:Number(m[3])}]:[];
 }).slice(0,6);
 const code=SQL_CODES.has(error?.code)||SYSTEM_CODES.has(error?.code)?error.code:knownCode??'unexpected_error';
 return {code,name:NAMES.has(error?.name)?error.name:'Error',frames};
}

// Never log request bodies, query strings, credentials, error messages or raw stacks.
// The supplied ID is internal request context, never an incoming client header.
export function requestDiagnostics(request,{requestId,transport='http',origin,emit=line=>console.error(line)}={}){
 const id=ID.test(requestId??'')?requestId:'crq_'+randomUUID().replaceAll('-','');
 const caller=request.headers?.get('origin');
 const originClass=!caller?'none':caller===origin?'configured':caller==='https://claus.si'?'claus':'other';
 return {id,headers:{'x-claus-request-id':id},failure({status,error,code=null,operation=null,route=null,phase='execute'}){
  if(status<500&&code!=='wrong_origin')return;
  try{
   const record={type:'claus.request.failure.v1',requestId:id,at:new Date().toISOString(),transport,status,
    method:['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(request.method)?request.method:'OTHER',
    operation:typeof operation==='string'&&/^[a-z_]{1,80}$/.test(operation)?operation:null,
    route:typeof route==='string'&&/^\/[A-Za-z0-9_/{}/-]{0,200}$/.test(route)?route:null,
    phase,originClass,fault:safeFault(error,code),cause:error?.cause?safeFault(error.cause):null};
   emit(JSON.stringify(record));
  }catch{/* Diagnostics must never replace the original response or replay work. */}
 }};
}
