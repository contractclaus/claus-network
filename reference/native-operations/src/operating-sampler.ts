import {operatingAssessment} from './operating-assessment.js';
export async function sampleOperatingBudget({history,read,save,now=Date.now}:any){
 try{
  const at=now(),rows=await history();const last=rows.map((r:any)=>r.document??r).filter((r:any)=>Number.isSafeInteger(r.observedAt)&&r.observedAt<=at).sort((a:any,b:any)=>b.observedAt-a.observedAt)[0];
  if(last&&at-last.observedAt<1800000)return {state:'recent',observedAt:last.observedAt};
  const result=operatingAssessment(await read(),rows,at);if(result.state==='unknown')return {state:'unavailable'};
  await save(result);return {state:'observed',observedAt:at,forecastReady:result.forecastReady};
 }catch{return {state:'unavailable'}}
}
