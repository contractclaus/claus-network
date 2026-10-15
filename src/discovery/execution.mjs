// Existing isolated-worker runs are capped at 1,000 lifetime admissions. Read
// that bounded set, not private inputs, provider handles or an invented uptime.
export async function executionEvidence(store,at) {
  if(!store.workerExecutionStates&&!store.list)return {state:'unavailable',scope:'isolated-json-worker-v1'};
  const fetched=store.workerExecutionStates?await store.workerExecutionStates():await store.list('worker-runs',{limit:1000});
  const rows=fetched.slice(0,1000),complete=fetched.length<=1000;
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
    coverage:{records:rows.length,maximum:1000,complete,scope:'current lifetime admission limit'}};
}
