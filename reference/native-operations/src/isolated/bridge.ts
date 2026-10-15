import program from './network.json' with {type:'json'};
import {analyzeProjection,programHash} from './runner.mjs';

const readState=(read:any)=>read?.available===true?'available':read?.available===false?'unavailable':'unknown';
// Pass availability only, never private projects, runtime inputs, jobs, keys or balances.
export function analyzeProducts(snapshot:any){
 const subjects=Array.isArray(snapshot.items)?snapshot.items.map((item:any)=>({id:item.project.id,reads:Object.fromEntries(['metrics','publicView','runtimes','inference'].map(key=>[key,readState(item[key])]))})):[];
 return analyzeProjection(program,{kind:'projects',observedAt:Date.now(),subjects});
}
export async function isolatedHealth(){
 const result=await analyzeProjection(program,{kind:'probe',observedAt:Date.now(),subjects:[]});
 return {state:result.state,sourceHash:result.sourceHash,profile:'data-only-analysis/1',...(result.error?{error:result.error}:{})};
}
export const isolatedSourceHash=()=>programHash(program);
