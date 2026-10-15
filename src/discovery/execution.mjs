// PostgreSQL aggregates the full stored history; alternate stores disclose
// bounded coverage. Neither path reads private inputs or invents uptime.
export async function executionEvidence(store,at) {
  if(store.workerExecutionSummary){
    try{return aggregateExecution(await store.workerExecutionSummary(at),at);}
    catch{return {state:'unavailable',scope:'isolated-json-worker-v1',observedAt:at,error:'execution_read_unavailable'};}
  }
  if(!store.workerExecutionStates&&!store.list)return {state:'unavailable',scope:'isolated-json-worker-v1'};
  const fetched=store.workerExecutionStates?await store.workerExecutionStates():await store.list('worker-runs',{limit:1000});
  const rows=fetched.slice(0,1000),complete=store.workerExecutionStates?fetched.length<=1000:fetched.length<1000;
  const totals={queued:0,running:0,completed:0,failed:0,cancelled:0,unknown:0};
  const since=at-86400000,finishedLast24h={completed:0,failed:0,cancelled:0,unknown:0};
  let lastCompletedAt=null,overdueLeases=0,unrecognized=0;
  for(const {value:v} of rows){
    if(Object.hasOwn(totals,v.state))totals[v.state]++;else unrecognized++;
    const ended=Number.isSafeInteger(v.finishedAt)&&v.finishedAt<=at;
    if(ended&&v.state==='completed')lastCompletedAt=Math.max(lastCompletedAt??0,v.finishedAt);
    if(ended&&v.finishedAt>=since&&Object.hasOwn(finishedLast24h,v.state))finishedLast24h[v.state]++;
    if(v.state==='running'&&Number.isSafeInteger(v.lease?.until)&&v.lease.until<=at)overdueLeases++;
  }
  return {state:complete?'observed':'partial',scope:'isolated-json-worker-v1',observedAt:at,totals,unrecognized,
    lastCompletedAt,overdueLeases,window:{from:since,to:at,finished:finishedLast24h},
    evidence:'Stored run outcomes, not task acceptance, live agent presence or independent uptime. Unknown execution outcomes are not retried automatically.',
    coverage:{records:rows.length,maximum:1000,complete,scope:'bounded history read'}};
}

export function aggregateExecution(groups,at){
 const totals={queued:0,running:0,completed:0,failed:0,cancelled:0,unknown:0},finished={completed:0,failed:0,cancelled:0,unknown:0};
 let records=0,unrecognized=0,overdueLeases=0,lastCompletedAt=null;
 const n=v=>{const x=Number(v);if(!Number.isSafeInteger(x)||x<0)throw Error('invalid_execution_summary');return x;};
 for(const g of groups){const count=n(g.count);records=n(records+count);if(Object.hasOwn(totals,g.state))totals[g.state]+=count;else unrecognized+=count;if(Object.hasOwn(finished,g.state))finished[g.state]+=n(g.recent_count);overdueLeases+=n(g.overdue);if(g.last_completed_at!==null)lastCompletedAt=Math.max(lastCompletedAt??0,n(g.last_completed_at));}
 return {state:'observed',scope:'isolated-json-worker-v1',observedAt:at,totals,unrecognized,lastCompletedAt,overdueLeases,window:{from:at-86400000,to:at,finished},evidence:'Stored run outcomes, not task acceptance, live agent presence or independent uptime. Unknown execution outcomes are not retried automatically.',coverage:{records,maximum:null,complete:true,scope:'stored execution history'}};
}
