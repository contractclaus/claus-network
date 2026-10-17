import {randomUUID} from 'node:crypto';

// Runs independently of model calls. Disabling new admissions must still let
// the controller stop existing resources and reconcile their original costs.
export async function infrastructureCycle({infrastructure,store,now=()=>Date.now()}){
 const capability=await infrastructure.discovery();
 if(!capability.reconciliation)return {state:'not_configured',processed:0};
 const key='infrastructure',token=randomUUID();
 const work=await store.transaction(async tx=>{
  const row=await tx.read('controller-cursors',key);
  if(row?.value.leaseUntil>now())return null;
  const value={after:row?.value.after??'',token,leaseUntil:now()+120000};
  await tx.write('controller-cursors',key,value,row?.revision??0);return value;
 });
 if(!work)return {state:'running',processed:0};
 try{
  let result=await infrastructure.tick({after:work.after,limit:1});
  // Reaching the end of the list must not consume a whole scheduled minute.
  // The first pass did no work, so wrapping retains the one-resource limit.
  if(work.after&&result.processed===0&&result.nextCursor===null)
    result=await infrastructure.tick({after:'',limit:1});
  await store.transaction(async tx=>{
   const row=await tx.read('controller-cursors',key);if(row?.value.token!==token)return;
   await tx.write('controller-cursors',key,{after:result.nextCursor??'',token:null,leaseUntil:0,observedAt:now()},row.revision);
  });
  return {state:'observed',...result};
 }catch{
  await store.transaction(async tx=>{
   const row=await tx.read('controller-cursors',key);if(row?.value.token!==token)return;
   await tx.write('controller-cursors',key,{...row.value,token:null,leaseUntil:0},row.revision);
  });
  return {state:'unavailable',processed:0};
 }
}
