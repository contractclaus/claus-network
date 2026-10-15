import program from './work.json' with {type:'json'};
import {evaluateProgram,programHash} from './runner.mjs';

// Only owned work identifiers and scheduling metadata cross this boundary.
// Credentials, private messages, task content, effects and money stay in the host.
export async function planWork(items:any[],now:number,source:unknown=program){
 const eligible=items.filter(item=>['ready','working','waiting'].includes(item.status)&&Date.parse(item.next_at)<=now);
 const input={observedAt:now,items:eligible.map(item=>({id:item.id,status:item.status,priority:item.priority,createdAt:Date.parse(item.created_at),nextAt:Date.parse(item.next_at)}))};
 let sourceHash:string|null=null;
 try{
  sourceHash=programHash(source);
  if(input.items.length>24||new Set(input.items.map(item=>item.id)).size!==input.items.length)throw Error('isolated_work_input_invalid');
  const value=await evaluateProgram(source,input,'plan');
  const allowed=new Set(input.items.map(item=>item.id));
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).join(',')!=='order'||!Array.isArray(value.order)||value.order.length!==allowed.size||new Set(value.order).size!==allowed.size||value.order.some((id:unknown)=>!allowed.has(id)))throw Error('isolated_work_order_invalid');
  return {state:'available',sourceHash,order:value.order as string[],meaning:'Tie-breaking among eligible original work only. Host enforces priority, due time, in-progress work and authorization.'};
 }catch{
  return {state:'unavailable',sourceHash,order:[] as string[],error:'isolated_work_failed',meaning:'Original scheduling remains in use; no work or effect was removed or replayed.'};
 }
}
export async function workPlannerHealth(){
 const sample=[{id:'probe',status:'ready',priority:2,next_at:'2026-01-01T00:00:00Z',created_at:'2026-01-01T00:00:00Z'}];
 const result=await planWork(sample,Date.parse('2026-01-02T00:00:00Z'));
 return {state:result.state,sourceHash:result.sourceHash,profile:'owned-work-order/1',...(result.state==='unavailable'?{error:result.error}:{})};
}
