import { sleep } from 'workflow';
import { start } from 'workflow/api';
import { cycle } from './cycle.js';
import {wakeDecision} from './social.js';
import {runClubWake} from './club-wake.js';
import {productionLabDatabase} from './lab-db.js';
import {runtimeContinuationTarget} from './runtime-continuity.js';

export async function life(generation:number):Promise<{status:string;nextAt?:string|null;continuedAs?:string}> {
  'use workflow';
  // Bound each run's replay history, then follow the latest deployed code.
  for(let turns=0;turns<128;turns++) {
    const wake=await checkInbox(generation);
    if(!wake.nextAt)return {status:'stopped'};
    if(wake.continuationDeployment){
      const run=await start(life,[generation],{deploymentId:wake.continuationDeployment});
      return {status:'continued',continuedAs:run.runId};
    }
    if(wake.run) {
      const result=await turn(generation);
      if(!result.nextAt)return result;
    } else await sleep(new Date(wake.nextAt));
  }
  const run=await start(life,[generation],{deploymentId:'latest'});
  return {status:'continued',continuedAs:run.runId};
}
async function checkInbox(generation:number) {
 'use step';
 const wake=await wakeDecision(generation);
 return {...wake,continuationDeployment:wake.nextAt?await runtimeContinuationTarget(productionLabDatabase(),generation):null};
}
checkInbox.maxRetries=0;
async function turn(generation:number) {
  'use step';
  return cycle(generation);
}
// Paid requests have their own journal; an unexpected whole-step replay must
// not generate a fresh paid turn after a crash. Recovery is explicit in SQL.
turn.maxRetries=0;

// A short, event-driven turn shares the same state, memory and exclusive lease
// as the persistent worker. It never starts a second autonomous identity.
export async function clubWake(generation:number,ticket:string):Promise<{status:string;nextAt?:string|null;continuedAs?:string}> {
 'use workflow';
 for(let turns=0;turns<128;turns++){
  const result=await clubTurn(generation,ticket);
  if(result.status!=='waiting')return result;
  if(result.continuationDeployment){
   const run=await start(clubWake,[generation,ticket],{deploymentId:result.continuationDeployment});
   return {status:'continued',continuedAs:run.runId};
  }
 }
 const run=await start(clubWake,[generation,ticket],{deploymentId:'latest'});
 return {status:'continued',continuedAs:run.runId};
}
async function clubTurn(generation:number,ticket:string) {
 'use step';
 const result=await runClubWake(generation,ticket,cycle);
 return {...result,continuationDeployment:result.status==='waiting'?await runtimeContinuationTarget(productionLabDatabase(),generation):null};
}
clubTurn.maxRetries=0;
