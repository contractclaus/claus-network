import program from './network.json' with {type:'json'};
import {analyzeProjection} from './runner.mjs';
// Public host-state projection only. The candidate never receives a store handle.
export function analyzeOperations(snapshot){
 const subjects=snapshot.workers.map(w=>({id:w.role,status:w.status,failedWorkers:Number.isSafeInteger(w.lastBatch?.failedWorkers)?w.lastBatch.failedWorkers:0}));
 return analyzeProjection(program,{kind:'operations',observedAt:snapshot.observedAt,subjects});
}
export async function isolatedHealth(){
 const result=await analyzeProjection(program,{kind:'probe',observedAt:Date.now(),subjects:[]});
 return {state:result.state,sourceHash:result.sourceHash,profile:'data-only-analysis/1',...(result.error?{error:result.error}:{})};
}
