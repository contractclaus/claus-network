import {encodeDeployData} from 'viem';
import {canonical,digest} from './evidence.js';
export function createProgramVerifier({repositoryStore,request=fetch,key=()=>process.env.PROGRAM_ETHERSCAN_KEY,clock=()=>Date.now()}){
 async function api(params){
  if(!key())throw Error('program_verifier_unavailable');
  const r=await request('https://api.etherscan.io/v2/api',{method:'POST',redirect:'error',body:new URLSearchParams({chainid:'1',module:'contract',apikey:key(),...params}),signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw Error('program_verification_unavailable');
  const text=await r.text();if(Buffer.byteLength(text)>4500000)throw Error('program_verification_response_too_large');return JSON.parse(text);
 }
 return async function verify({address,artifact,args=[]}){
  const constructorArgs=encodeDeployData({abi:artifact.abi,bytecode:artifact.creationBytecode,args}).slice(artifact.creationBytecode.length);
  const binding={address:address.toLowerCase(),artifactHash:digest(artifact),constructorArgs},id='program-verification:'+digest(binding).slice(7);
  const complete=await repositoryStore.release(id+':complete');if(complete)return complete;
  const observed=await api({action:'getsourcecode',address});
  if(observed.status==='1'&&observed.result[0]?.SourceCode){
   const v=observed.result[0];let source;try{source=JSON.parse(v.SourceCode.startsWith('{{')?v.SourceCode.slice(1,-1):v.SourceCode);}catch{throw Error('program_verification_source_mismatch');}
   const settings=['optimizer','evmVersion','viaIR','metadata','remappings','libraries'];
   const expectedSettings=Object.fromEntries(settings.map(k=>[k,artifact.standardInput.settings[k]??null]));
   const actualSettings=Object.fromEntries(settings.map(k=>[k,source.settings?.[k]??null]));
   // Absent external libraries and the default false viaIR value are equivalent.
   for(const o of [expectedSettings,actualSettings]){o.libraries??={};o.viaIR??=false;o.remappings??=[];}
   if(canonical(source.sources)!==canonical(artifact.standardInput.sources)||canonical(actualSettings)!==canonical(expectedSettings)||v.ContractName!==artifact.contract||
     v.CompilerVersion!=='v'+artifact.profile.compiler.replace('.Emscripten.clang','')||v.ConstructorArguments.toLowerCase()!==constructorArgs.toLowerCase())throw Error('program_verification_source_mismatch');
   const result={...binding,verified:true,url:'https://etherscan.io/address/'+address+'#code'};await repositoryStore.attest(id+':complete',result);return result;
  }
  // Only an explicit pre-admission rejection permits another submission.
  // A timeout, a provider GUID or any ambiguous reply retains the original.
  let attempt=0;
  for(;attempt<5;attempt++){
   const suffix=attempt===0?'':':'+attempt;
   const original=await repositoryStore.release(id+suffix+':attempt');
   if(!original)break;
   const accepted=await repositoryStore.release(id+suffix+':submitted');
   if(accepted?.guid)return {verified:false,state:'submitted',attempt,provider:await api({action:'checkverifystatus',guid:accepted.guid})};
   if(!accepted)return {verified:false,state:'outcome_unknown',attempt};
   if(!accepted.retryable)return {verified:false,state:'rejected',attempt,provider:accepted.result};
   if(clock()<accepted.retryAt)return {verified:false,state:'waiting_for_index',attempt,retryAt:accepted.retryAt};
  }
  if(attempt===5)return {verified:false,state:'rejected',attempts:attempt,reason:'indexing_retry_limit'};
  const suffix=attempt===0?'':':'+attempt;
  const intent=await repositoryStore.reserve(id+suffix+':dispatch','verification',binding);
  if(!intent.created)return {verified:false,state:'outcome_unknown',attempt};
  await repositoryStore.attest(id+suffix+':attempt',binding);
  const submitted=await api({action:'verifysourcecode',contractaddress:address,sourceCode:JSON.stringify(artifact.standardInput),codeformat:'solidity-standard-json-input',
   contractname:artifact.entry+':'+artifact.contract,compilerversion:'v'+artifact.profile.compiler.replace('.Emscripten.clang',''),constructorArguements:constructorArgs});
  const guid=submitted.status==='1'&&typeof submitted.result==='string'&&/^[a-z0-9]{20,100}$/i.test(submitted.result)?submitted.result:null;
  const retryable=submitted.status==='0'&&typeof submitted.result==='string'&&
   /(?:unable to locate contractcode|contract source code not verified.*not found|contract not yet indexed|please wait.*(?:index|contract))/i.test(submitted.result);
  const result={guid,result:submitted,retryable,retryAt:retryable?clock()+120000:null};
  await repositoryStore.attest(id+suffix+':submitted',result);
  return {verified:false,state:guid?'submitted':retryable?'waiting_for_index':'rejected',attempt,provider:submitted,...(retryable?{retryAt:result.retryAt}:{})};
 };
}
