import {nativeContinuity} from './native-continuity.js';
import {buildAllowances} from './builder-limits.js';
import {BuilderStore} from './builder-store.js';
import {BuilderWorker} from './builder-worker.js';
import {productionLabDatabase} from './lab-db.js';
import {configuration} from './store.js';
import {labInference} from './lab-model.js';
import {builderEnabled,builderRuntimeEnabled,BUILD_LIMITS} from './builder-schema.js';
let instance:BuilderStore|undefined;
export const builderStore=()=>instance??=new BuilderStore(productionLabDatabase());
export const builderTick=(id?:string)=>nativeContinuity('native','builder',id??null,{},()=>new BuilderWorker(builderStore(),labInference(),configuration).tick(id));
export async function readBuilder(args:any={},scope='claus'){
 builderStore().owner(scope);const visibility=scope==='claus'?'private_club':'private_workspace';
 const config=await configuration();
 if(!builderEnabled(config))throw Error('builder_disabled');
 if(!args.id)return {visibility,runtimes:builderRuntimeEnabled(config,'solidity')?['javascript','solidity']:['javascript'],limits:BUILD_LIMITS,usage:await builderStore().usage(scope),projects:await builderStore().list(scope)};
 const p=await builderStore().ownedDetail(args.id,scope);
 if(args.revision!==undefined&&(!Number.isSafeInteger(args.revision)||args.revision<1))throw Error('builder_revision_invalid');
 const v=args.revision===undefined?p.versions[0]:p.versions.find((v:any)=>v.revision===args.revision);
 if(args.revision!==undefined&&!v)throw Error('builder_revision_missing');
 if(args.export===true)return {id:p.id,title:p.title,runtime:p.runtime,revision:v?.revision??0,sourceHash:v?.source_hash??null,files:v?.files??[],projectStatus:p.status,checks:p.effects.filter((e:any)=>e.kind==='test'&&e.revision===v?.revision).map((e:any)=>({id:e.id,status:e.status,output:e.output})),deployed:false};
 if(args.path){const f=v?.files.find((f:any)=>f.path===args.path),offset=args.offset??0;if(!f||!Number.isSafeInteger(offset)||offset<0||offset>f.content.length)throw Error('builder_file_missing');return {id:p.id,revision:v.revision,path:f.path,sourceHash:v.source_hash,content:f.content.slice(offset,offset+12000),nextOffset:offset+12000<f.content.length?offset+12000:null,visibility};}
 return {id:p.id,title:p.title,goal:p.goal,status:p.status,revision:p.revision,summary:p.summary,mode:p.mode,runtime:p.runtime,visibility,limits:buildAllowances(p.owner_scope),versions:p.versions.map((v:any)=>({revision:v.revision,sourceHash:v.source_hash,summary:v.summary,files:v.files.map((f:any)=>f.path)})),effects:p.effects.map((e:any)=>({id:e.id,kind:e.kind,status:e.status,revision:e.revision,output:e.kind==='test'?e.output:undefined,reservedMicroUsdc:String(e.amount)})),deployed:false};
}
