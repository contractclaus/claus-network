import {ProviderFailure,providerJson} from './providers.js';

export const runpodStatus=(env:NodeJS.ProcessEnv=process.env)=>({
 configured:!!env.CLAUS_RUNPOD_API_KEY,
 operations:['describe','read'],
 views:['gpus','datacenters','pods'],
 provisioning:false,
 funding:'Separate infrastructure allowance and available provider credit required',
 secretsExposed:false
});

export async function runpodRequest(operation:string,input:any,fetcher:typeof fetch=fetch,env:NodeJS.ProcessEnv=process.env){
 if(operation==='describe')return runpodStatus(env);
 if(operation!=='read'||!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['view','cursor'].includes(k)))throw new ProviderFailure('runpod_read_input_invalid',true);
 const key=env.CLAUS_RUNPOD_API_KEY;
 if(!key)throw new ProviderFailure('runpod_not_connected',true);
 if(input.cursor!==undefined&&(input.view!=='pods'||typeof input.cursor!=='string'||input.cursor.length>1000))throw new ProviderFailure('runpod_cursor_invalid',true);
 let path:string;
 if(input.view==='gpus')path='/v2/catalog/gpus?include=AVAILABILITY&product=POD&cloud=SECURE';
 else if(input.view==='datacenters')path='/v2/catalog/datacenters';
 else if(input.view==='pods')path='/v2/pods?limit=100'+(input.cursor?'&cursor='+encodeURIComponent(input.cursor):'');
 else throw new ProviderFailure('runpod_view_invalid',true);
 const value=await providerJson('https://api.runpod.io'+path,{headers:{authorization:'Bearer '+key,accept:'application/json'}},true,fetcher);
 // Pod environment variables and registry credentials never leave this adapter.
 if(input.view==='pods'){
  if(!Array.isArray(value.pods)||!value.pagination)throw new ProviderFailure('runpod_response_invalid',true);
  return {view:input.view,observedAt:new Date().toISOString(),pods:value.pods.map((p:any)=>({id:p.id,name:p.name,status:p.status,image:p.image,region:p.dataCenterId,hourlyUsd:p.cost,createdAt:p.createdAt,startedAt:p.startedAt})),pagination:value.pagination,instructionAuthority:false};
 }
 return {view:input.view,observedAt:new Date().toISOString(),catalog:value,pricing:'Indicative provider catalog, not an approved spend or final invoice',instructionAuthority:false};
}
