import {copy,canonical,integer,requireThat} from '../shared/index.mjs';
import {evaluateService,serviceProgramHash} from '../isolated/service.mjs';
export const SERVICE_LIMITS=Object.freeze({services:16,requestBytes:8192,stateBytes:8192,responseBytes:8192});
const validName=s=>requireThat(typeof s==='string'&&/^[a-z][a-z0-9_-]{0,47}$/.test(s),'invalid_service_name');
// All state and receipt writes use the original project transaction. Guest code
// receives no transaction object, identity credential or financial document.
export function createAppServices({storage,manager,app,effect,event,program}) {
 const ready=()=>requireThat(storage&&program,'app_service_unavailable');
 return {
  async get(actor,projectId,{serviceId}) {
   ready();validName(serviceId);const tx=storage.reader(projectId);
   await manager(actor,projectId,tx.network);await app(tx,projectId);
   const row=await tx.read('service-state',serviceId);
   return {profile:'claus-app-service/1',projectId,serviceId,sourceHash:serviceProgramHash(program()),revision:row?.revision??0,limits:SERVICE_LIMITS,access:'app.manage'};
  },
  async call(actor,projectId,{serviceId,request,expectedRevision,expectedSourceHash,idempotencyKey}) {
   ready();validName(serviceId);integer(expectedRevision);
   requireThat(/^[a-f0-9]{64}$/.test(expectedSourceHash??''),'invalid_service_source');
   requireThat(request!==undefined&&Buffer.byteLength(canonical(request))<=SERVICE_LIMITS.requestBytes,'document_too_large');
   return storage.transaction(projectId,async tx=>{
    await manager(actor,projectId,tx.network);await app(tx,projectId);
    // Receipt is checked before current source/state: a deployment cannot make
    // an already committed original call execute again.
    return effect(tx,projectId,actor,'service:'+serviceId,idempotencyKey,{request,expectedRevision,expectedSourceHash},async principalId=>{
     const selected=program(),sourceHash=serviceProgramHash(selected);
     requireThat(sourceHash===expectedSourceHash,'service_source_changed');
     const old=await tx.read('service-state',serviceId);
     requireThat((old?.revision??0)===expectedRevision,'revision_conflict');
     const value=await evaluateService(selected,{projectId,serviceId,principalId,request:copy(request),state:copy(old?.value.state??null),revision:expectedRevision});
     let revision=old?.revision??0;
     if(Object.hasOwn(value,'state')){
      if(!old){const count=await tx.read('meta','services');requireThat((count?.value.count??0)<SERVICE_LIMITS.services,'capacity_reached');await tx.write('meta','services',{count:(count?.value.count??0)+1},count?.revision??0);}
      revision=(await tx.write('service-state',serviceId,{state:copy(value.state),sourceHash},expectedRevision)).revision;
     }
     const result={profile:'claus-app-service/1',projectId,serviceId,sourceHash,revision,status:value.status,body:copy(value.body)};
     await event(tx,{type:'service.called',serviceId,actorId:principalId,sourceHash,revision});
     return result;
    });
   });
  }
 };
}
