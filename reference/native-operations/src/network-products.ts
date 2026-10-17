import {analyzeProducts} from './isolated/bridge.js';
import {networkFailure} from './network-failure.js';
import {runtimeResourceView} from './runtime-resource-view.js';
export async function observeProducts(network:{call:(name:string,input:any)=>Promise<any>},after?:string,timeoutMs=12000,analyze=analyzeProducts){
 const deadline=Date.now()+timeoutMs,remaining=()=>Math.max(0,deadline-Date.now());
 let closed=false;const pending=new Set<ReturnType<typeof setTimeout>>();
 const observe=async(operation:string,input:any)=>{if(closed||!remaining())return {available:false,...networkFailure(Error('observation_deadline'))};let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([network.call(operation,input).then(value=>({available:true,value})).catch(e=>({available:false,...networkFailure(e)})),new Promise<any>(resolve=>{timer=setTimeout(()=>resolve({available:false,...networkFailure(Error('observation_deadline'))}),remaining());pending.add(timer);})]);}finally{if(timer){clearTimeout(timer);pending.delete(timer);}}};
 try{
 const page=await observe('project_list',{limit:10,...(after?{after}:{})});
 if(!page.available)return {observedAt:new Date().toISOString(),available:false,failure:page,items:null,nextCursor:null,helpRequests:null,helpRequestsStatus:'not-read'};
 const projects=page.value.items;
 const unavailable=()=>({available:false,...networkFailure(Error('observation_deadline'))});
 const items:any[]=projects.map((project:any)=>({project,metrics:unavailable(),publicView:unavailable(),runtimes:unavailable(),inference:unavailable(),resources:unavailable(),resourceProfiles:unavailable()}));
 const operations=[['metrics','app_metrics'],['publicView','public_project'],['runtimes','runtime_list'],['inference','inference_profiles'],['resources','resource_instances'],['resourceProfiles','resource_profiles']];
 const tasks=items.flatMap((item:any)=>operations.map(([key,operation])=>({item,key,operation,input:operation==='public_project'?{slug:item.project.slug}:{projectId:item.project.id}})));
 let index=0;
 const assistance=observe('public_project_assistance',{limit:10});
 const worker=async()=>{while(!closed){const task=tasks[index++];if(!task)break;const result=await observe(task.operation,task.input);if(!closed)task.item[task.key]=result;}};
 await Promise.race([Promise.all(Array.from({length:Math.min(4,tasks.length)},worker)),new Promise<void>(resolve=>{const timer=setTimeout(()=>{pending.delete(timer);closed=true;resolve();},remaining());pending.add(timer);})]);
 closed=true;
 const help=await assistance;
 const snapshot={observedAt:new Date().toISOString(),available:true,items:items.map(item=>({...item,infrastructure:runtimeResourceView(item.resources,item.resourceProfiles)})),nextCursor:page.value.nextCursor,helpRequests:help.available?help.value:null,helpRequestsStatus:help.available?'available':'unavailable',...(!help.available?{helpRequestsFailure:help}:{})};
 return {...snapshot,analysis:await analyze(snapshot)};
 }finally{closed=true;for(const timer of pending)clearTimeout(timer);}
}
