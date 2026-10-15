// Runtime scheduling and inference reconciliation are independent work lanes.
// A failed lane never suppresses the other or creates a replacement request.
export async function computeCycle({app,store,now=()=>Date.now(),release=null}) {
 const started=now();
 const outcomes=await Promise.allSettled([
  app.runtimes.tick(),
  (async()=>{
   if(!(await app.inference.discovery()).enabled)return {enabled:false,completedWorkers:0,failedWorkers:0};
   const workers=await Promise.allSettled([app.inference.run(),app.inference.run()]);
   return {enabled:true,completedWorkers:workers.filter(r=>r.status==='fulfilled').length,failedWorkers:workers.filter(r=>r.status==='rejected').length};
  })()
 ]);
 const runtime=outcomes[0].status==='fulfilled'?{state:'observed',processed:outcomes[0].value.processed}:{state:'unavailable'};
 const inference=outcomes[1].status==='fulfilled'?{state:'observed',...outcomes[1].value}:{state:'unavailable'};
 const observedAt=now();
 await store.transaction(async tx=>{
  for(const [role,state]of [['runtimes',runtime],['inference',inference]]){
   const old=await tx.read('worker-health',role);
   await tx.write('worker-health',role,{...state,observedAt,durationMs:Math.max(0,observedAt-started),release},old?.revision??0);
  }
 });
 return {ok:runtime.state==='observed'&&inference.state==='observed'&&inference.failedWorkers===0,runtime,inference};
}
