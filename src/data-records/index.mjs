import {canonical,copy,digest,integer,requireThat,text} from '../shared/index.mjs';
export const RECORD_LIMITS=Object.freeze({recordBytes:32768,projectBytes:33554432,globalBytes:268435456,records:10000,mutations:50000});
const component=v=>{requireThat(typeof v==='string'&&/^[a-zA-Z0-9_.-]{1,120}$/.test(v),'data_record_key_invalid');return v;};
const location=(projectId,namespace,key)=>projectId+':'+component(namespace)+':'+component(key);
const view=r=>({namespace:r.value.namespace,key:r.value.key,revision:r.revision,deleted:r.value.deleted,updatedAt:r.value.updatedAt,valueHash:r.value.valueHash,bytes:r.value.bytes});
export function createDataRecords({store,identity,now=()=>Date.now(),limits=RECORD_LIMITS}){
 const auth=(actor,projectId,write=false,reader=store)=>identity.authorize(actor,write?'artifact.write':'artifact.read',{projectId},reader);
 async function mutate(actor,projectId,input,deleted){
  const {namespace,key,expectedRevision,idempotencyKey}=input;integer(expectedRevision);text(idempotencyKey);requireThat(idempotencyKey.length<=128,'invalid_identifier');
  const id=location(projectId,namespace,key),value=deleted?null:copy(input.value),body=canonical(value),bytes=deleted?0:Buffer.byteLength(body);requireThat(bytes<=limits.recordBytes,'data_record_too_large');
  const requestHash=digest({id,expectedRevision,value,deleted}),receipt=digest({projectId,idempotencyKey});
  return store.transaction(async tx=>{
   await auth(actor,projectId,true,tx);const oldReceipt=await tx.read('data-record-receipts',receipt);
   if(oldReceipt){requireThat(oldReceipt.value.requestHash===requestHash,'idempotency_conflict');return copy(oldReceipt.value.result);}
   const old=await tx.read('data-records',id);requireThat((old?.revision??0)===expectedRevision,'revision_conflict');
   if(deleted)requireThat(old,'not_found');
   const change=bytes-(old?.value.bytes??0),count=(deleted?0:1)-(old&&!old.value.deleted?1:0);
   for(const scope of [projectId,'global']){
    const previous=await tx.read('data-record-capacity',scope),v=previous?.value??{bytes:0,records:0,mutations:0};
    const next={bytes:v.bytes+change,records:v.records+count,mutations:v.mutations+1};
    requireThat(next.bytes>=0&&next.records>=0,'data_record_capacity_corrupt');
    requireThat(next.bytes<=(scope==='global'?limits.globalBytes:limits.projectBytes)&&next.records<=(scope==='global'?100000:limits.records)&&next.mutations<=(scope==='global'?500000:limits.mutations),'data_record_capacity_reached');
    await tx.write('data-record-capacity',scope,next,previous?.revision??0);
   }
   const saved=await tx.write('data-records',id,{projectId,namespace,key,value,deleted,bytes,valueHash:digest(value),updatedAt:now()},expectedRevision),result=view(saved);
   await tx.write('data-record-receipts',receipt,{projectId,requestHash,result,createdAt:now()},0);return result;
  });
 }
 return {
  discovery:()=>({enabled:true,profile:'claus-project-records/1',private:true,storage:'managed-database',optimisticConcurrency:true,originalRequestReceipts:true,limits,scope:{read:'artifact.read',write:'artifact.write'}}),
  put:(a,p,i)=>mutate(a,p,i,false),remove:(a,p,i)=>mutate(a,p,i,true),
  async get(actor,projectId,{namespace,key}){await auth(actor,projectId);const r=await store.read('data-records',location(projectId,namespace,key));requireThat(r?.value.projectId===projectId,'not_found');return {...view(r),value:copy(r.value.value)};},
  async list(actor,projectId,{namespace,after='',limit=50}){component(namespace);integer(limit,1,100);requireThat(typeof after==='string','invalid_cursor');await auth(actor,projectId);
   const prefix=projectId+':'+namespace+':';requireThat(!after||after.startsWith(prefix),'invalid_cursor');const rows=await store.list('data-records',{projectId,prefix,after,limit});const usage=(await store.read('data-record-capacity',projectId))?.value??{bytes:0,records:0,mutations:0};
   return {items:rows.filter(r=>!r.value.deleted).map(r=>({...view(r),value:copy(r.value.value)})),nextCursor:rows.length===limit?rows.at(-1).id:null,usage,limits};}
 };
}
