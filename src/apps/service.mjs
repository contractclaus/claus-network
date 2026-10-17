import {copy,canonical,integer,requireThat} from '../shared/index.mjs';
import {evaluateService,serviceProgramHash} from '../isolated/service.mjs';
export const SERVICE_LIMITS=Object.freeze({services:16,versions:32,sourceBytes:128000,requestBytes:65536,stateBytes:65536,responseBytes:65536});
const validName=s=>requireThat(typeof s==='string'&&/^[a-z][a-z0-9_-]{0,47}$/.test(s),'invalid_service_name');
// All state and receipt writes use the original project transaction. Guest code
// receives no transaction object, identity credential or financial document.
export function createAppServices({storage,manager,participant,app,effect,event,program}) {
 const ready=()=>requireThat(storage&&program,'app_service_unavailable');
 const selected=async(tx,serviceId)=>{const row=await tx.read('service-code',serviceId);return {row,program:row?.value.program??program(),access:row?.value.access??'manager'};};
 async function caller(actor,projectId,tx,selection){if(selection.access==='members')await participant(tx,projectId,actor);else await manager(actor,projectId,tx.network);}
 return {limits:SERVICE_LIMITS,
  async configure(actor,projectId,{serviceId,program:source,access='manager',expectedRevision,idempotencyKey}){
   ready();validName(serviceId);integer(expectedRevision);requireThat(['manager','members'].includes(access),'invalid_service_access');
   let sourceHash;try{sourceHash=serviceProgramHash(source);}catch{requireThat(false,'isolated_program_invalid');}
   return storage.transaction(projectId,async tx=>{
    await manager(actor,projectId,tx.network);await app(tx,projectId);
    return effect(tx,projectId,actor,'service.configure:'+serviceId,idempotencyKey,{source,access,expectedRevision},async principalId=>{
     const old=await tx.read('service-code',serviceId);requireThat((old?.revision??0)===expectedRevision,'revision_conflict');
     requireThat(expectedRevision<SERVICE_LIMITS.versions,'capacity_reached');
     if(!old){const count=await tx.read('meta','service-code-count');requireThat((count?.value.count??0)<SERVICE_LIMITS.services,'capacity_reached');await tx.write('meta','service-code-count',{count:(count?.value.count??0)+1},count?.revision??0);}
     const value={program:copy(source),sourceHash,access,authorId:principalId};
     const row=await tx.write('service-code',serviceId,value,expectedRevision);
     await tx.write('service-versions',serviceId+':'+String(row.revision).padStart(4,'0'),{serviceId,...value,sourceRevision:row.revision},0);
     await event(tx,{type:'service.configured',serviceId,actorId:principalId,sourceHash,sourceRevision:row.revision});
     return {profile:'claus-app-service/2',projectId,serviceId,sourceHash,sourceRevision:row.revision,access};
    });
   });
  },
  async get(actor,projectId,{serviceId}) {
   ready();validName(serviceId);const tx=storage.reader(projectId);
   const selection=await selected(tx,serviceId);await caller(actor,projectId,tx,selection);await app(tx,projectId);
   const row=await tx.read('service-state',serviceId);
   return {profile:selection.row?'claus-app-service/2':'claus-app-service/1',projectId,serviceId,sourceHash:serviceProgramHash(selection.program),sourceRevision:selection.row?.revision??0,revision:row?.revision??0,limits:SERVICE_LIMITS,access:selection.access==='members'?'app.member':'app.manage'};
  },
  async call(actor,projectId,{serviceId,request,expectedRevision,expectedSourceHash,idempotencyKey}) {
   ready();validName(serviceId);integer(expectedRevision);
   requireThat(/^[a-f0-9]{64}$/.test(expectedSourceHash??''),'invalid_service_source');
   requireThat(request!==undefined&&Buffer.byteLength(canonical(request))<=SERVICE_LIMITS.requestBytes,'document_too_large');
   return storage.transaction(projectId,async tx=>{
    const selection=await selected(tx,serviceId);await caller(actor,projectId,tx,selection);await app(tx,projectId);
    // Receipt is checked before current source/state: a deployment cannot make
    // an already committed original call execute again.
    return effect(tx,projectId,actor,'service:'+serviceId,idempotencyKey,{request,expectedRevision,expectedSourceHash},async principalId=>{
     const chosen=selection.program,sourceHash=serviceProgramHash(chosen);
     requireThat(sourceHash===expectedSourceHash,'service_source_changed');
     const old=await tx.read('service-state',serviceId);
     requireThat((old?.revision??0)===expectedRevision,'revision_conflict');
     let value;try{value=await evaluateService(chosen,{projectId,serviceId,principalId,request:copy(request),state:copy(old?.value.state??null),revision:expectedRevision});}catch(error){if(['isolated_service_failed','isolated_service_input_size','isolated_service_output_size','isolated_service_output_invalid'].includes(error?.message))requireThat(false,error.message);throw error;}
     let revision=old?.revision??0;
     if(Object.hasOwn(value,'state')){
      if(!old){const count=await tx.read('meta','services');requireThat((count?.value.count??0)<SERVICE_LIMITS.services,'capacity_reached');await tx.write('meta','services',{count:(count?.value.count??0)+1},count?.revision??0);}
      revision=(await tx.write('service-state',serviceId,{state:copy(value.state),sourceHash},expectedRevision)).revision;
     }
     const result={profile:selection.row?'claus-app-service/2':'claus-app-service/1',projectId,serviceId,sourceHash,sourceRevision:selection.row?.revision??0,revision,status:value.status,body:copy(value.body)};
     await event(tx,{type:'service.called',serviceId,actorId:principalId,sourceHash,revision});
     return result;
    });
   });
  }
 };
}
