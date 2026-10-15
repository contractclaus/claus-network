type Action = {id:string;kind:string;created_at:string;progress?:any};
type Dependencies = {
 read:(id:string,signal:AbortSignal)=>Promise<any>;
 settle:(id:string,value:any,status:'completed'|'failed')=>Promise<unknown>;
 schedule:(id:string,value:{checkedAt:string;nextAt:string})=>Promise<unknown>;
};

// Receipt reads never send a post. One slow read must not hold up all siblings.
// Old unknown sends retain their IDs and rotate through this bounded batch.
export async function recoverSenderReceipts(actions:Action[],d:Dependencies,after:string,now=Date.now(),deadlineMs=6000) {
 const admitted=Date.parse(after);
 if(!Number.isFinite(admitted))return;
 const selected=actions.filter(a=>a.kind==='x_post'&&Date.parse(a.created_at)>=admitted&&
   !(Date.parse(a.progress?.senderReadback?.nextAt)>now))
  .sort((a,b)=>(Date.parse(a.progress?.senderReadback?.checkedAt)||0)-(Date.parse(b.progress?.senderReadback?.checkedAt)||0)||a.id.localeCompare(b.id)).slice(0,8);
 const results=await Promise.allSettled(selected.map(async a=>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([
   Promise.resolve().then(()=>d.read(a.id,controller.signal)),
   new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('receipt_deadline'));},deadlineMs);})
  ]);}finally{clearTimeout(timer);}
 }));
 for(let i=0;i<selected.length;i++){
  const a=selected[i],read=results[i];
  try{
   const r=read.status==='fulfilled'?read.value:null;
   if(r?.status==='completed'&&/^[1-9]\d{0,18}$/.test(r.result?.data?.id??'')){
    await d.settle(a.id,r.result,'completed');continue;
   }
   if(r?.status==='failed'&&r.failure?.definite===true&&typeof r.failure.error==='string'){
    await d.settle(a.id,{error:r.failure.error,...(r.failure.retryAt?{retryAt:r.failure.retryAt}:{})},'failed');continue;
   }
  }catch{/* An uncertain receipt write still cannot authorize another send. */}
  try{await d.schedule(a.id,{checkedAt:new Date(now).toISOString(),nextAt:new Date(now+60000).toISOString()});}catch{/* Leave the original pending action intact. */}
 }
}
