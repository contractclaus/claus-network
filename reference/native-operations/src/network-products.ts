import {analyzeProducts} from './isolated/bridge.js';
import {networkFailure} from './network-failure.js';
export async function observeProducts(network:{call:(name:string,input:any)=>Promise<any>},after?:string,timeoutMs=12000,analyze=analyzeProducts){
 const deadline=Date.now()+timeoutMs,remaining=()=>Math.max(0,deadline-Date.now());
 let closed=false;const pending=new Set<ReturnType<typeof setTimeout>>();
 const observe=async(operation:string,input:any)=>{if(closed||!remaining())return {available:false,...networkFailure(Error('observation_deadline'))};let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([network.call(operation,input).then(value=>({available:true,value})).catch(e=>({available:false,...networkFailure(e)})),new Promise<any>(resolve=>{timer=setTimeout(()=>resolve({available:false,...networkFailure(Error('observation_deadline'))}),remaining());pending.add(timer);})]);}finally{if(timer){clearTimeout(timer);pending.delete(timer);}}};
 try{
 const page=await observe('project_list',{limit:10,...(after?{after}:{})});
 if(!page.available)return {observedAt:new Date().toISOString(),available:false,failure:page,items:null,nextCursor:null,helpRequests:null,helpRequestsStatus:'not-read'};
 const projects=page.value.items;
 const unavailable=()=>({available:false,...networkFailure(Error('observation_deadline'))});
 const items:any[]=projects.map((project:any)=>({project,metrics:unavailable(),publicView:unavailable(),runtimes:unavailable(),inference:unavailable()}));let index=0;
 const assistance=observe('public_project_assistance',{limit:10});
 const worker=async()=>{while(!closed){const i=index++;if(i>=projects.length)break;const p=projects[i];await Promise.all([['metrics','app_metrics',{projectId:p.id}],['publicView','public_project',{slug:p.slug}],['runtimes','runtime_list',{projectId:p.id}],['inference','inference_profiles',{projectId:p.id}]].map(async([key,operation,input])=>{const result=await observe(operation as string,input);if(!closed)items[i][key as string]=result;}));}};
 await Promise.race([Promise.all(Array.from({length:Math.min(3,projects.length)},worker)),new Promise<void>(resolve=>{const timer=setTimeout(()=>{pending.delete(timer);closed=true;resolve();},remaining());pending.add(timer);})]);
 closed=true;
 const help=await assistance;
 const snapshot={observedAt:new Date().toISOString(),available:true,items,nextCursor:page.value.nextCursor,helpRequests:help.available?help.value:null,helpRequestsStatus:help.available?'available':'unavailable',...(!help.available?{helpRequestsFailure:help}:{})};
 return {...snapshot,analysis:await analyze(snapshot)};
 }finally{closed=true;for(const timer of pending)clearTimeout(timer);}
}
