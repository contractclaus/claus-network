import {canonical,digest,integer,requireThat,sourcePath,text} from '../shared/index.mjs';

export const WORKER_LIMITS=Object.freeze({files:20,sourceBytes:256000,jsonBytes:16000,commandSeconds:30,vmSeconds:60,activePerProject:1,activeGlobal:4,projectDaily:20,globalDaily:100,lifetime:1000,definitionsPerProject:5,leaseMs:120000});
const terminal=new Set(['completed','failed','cancelled','unknown']);
const name=value=>{requireThat(typeof value==='string'&&/^[a-z][a-z0-9-]{0,39}$/.test(value),'invalid_worker_name');return value;};
const json=value=>{const encoded=JSON.stringify(value);requireThat(typeof encoded==='string'&&Buffer.byteLength(encoded)<=WORKER_LIMITS.jsonBytes,'worker_json_too_large');JSON.parse(encoded);return encoded;};
export function createWorkers({store,identity,projects,artifacts,now=()=>Date.now(),ports={},enabled=false}){
 const key=(projectId,workerId)=>projectId+':'+name(workerId);
 async function admission(reader){requireThat(enabled&&(await reader.read('network-capabilities','workers'))?.value.enabled===true,'workers_not_enabled');}
 async function authorized(actor,action,projectId,reader=store){await identity.authorize(actor,action,{projectId},reader);}
 const describe=row=>({...row.value,revision:row.revision});
 function output(row){const {actor,lease,progress,inputJson,...value}=row.value;return {...value,revision:row.revision,result:value.resultJson===undefined?undefined:JSON.parse(value.resultJson)};}
 async function finish(id,token,changes){return store.transaction(async tx=>{const r=await tx.read('worker-runs',id);if(!r||r.value.lease?.token!==token)return false;const cancelled=r.value.cancelledAt!==undefined;await tx.write('worker-runs',id,{...r.value,...changes,state:cancelled?'cancelled':changes.state,finishedAt:now(),lease:null},r.revision);const c=await tx.read('worker-capacity','global');await tx.write('worker-capacity','global',{...c.value,active:c.value.active.filter(x=>x!==id)},c.revision);return true;});}
 return {limits:WORKER_LIMITS,
  async discovery(){let admitted=false;try{await admission(store);admitted=true;}catch(e){if(e.code!=='workers_not_enabled')throw e;}return{enabled:admitted,profile:'isolated-json-worker-v1',limits:WORKER_LIMITS,network:'denied',persistent:false};},
  async configure(actor,projectId,{workerId,snapshotId,entry,paths,enabled:active=true,expectedRevision}){
   name(workerId);sourcePath(entry);integer(expectedRevision);requireThat(typeof active==='boolean'&&Array.isArray(paths)&&paths.length>0&&paths.length<=WORKER_LIMITS.files&&new Set(paths).size===paths.length&&paths.includes(entry),'invalid_worker_files');
   await authorized(actor,'worker.manage',projectId);await admission(store);
   const source=await projects.files(actor,projectId,snapshotId),files=paths.map(p=>{sourcePath(p);const f=source.find(x=>x.path===p);requireThat(f&&/\.(mjs|js|json)$/.test(p),'invalid_worker_files');return{path:p,content:f.content};});
   requireThat(entry.endsWith('.mjs')&&Buffer.byteLength(canonical(files))<=WORKER_LIMITS.sourceBytes,'invalid_worker_source');
   return store.transaction(async tx=>{await authorized(actor,'worker.manage',projectId,tx);await admission(tx);const id=key(projectId,workerId),prior=await tx.read('project-workers',id);requireThat((prior?.revision??0)===expectedRevision,'revision_conflict');if(!prior){const count=await tx.read('worker-definitions',projectId);requireThat((count?.value.count??0)<WORKER_LIMITS.definitionsPerProject,'capacity_reached');await tx.write('worker-definitions',projectId,{count:(count?.value.count??0)+1},count?.revision??0);}const sourceHash=await artifacts.put(tx,projectId,files);return describe(await tx.write('project-workers',id,{projectId,workerId,snapshotId,entry,paths,sourceHash,enabled:active,updatedAt:now()},expectedRevision));});
  },
  async get(actor,projectId,workerId){await authorized(actor,'worker.read',projectId);const r=await store.read('project-workers',key(projectId,workerId));requireThat(r,'not_found');return describe(r);},
  async run(actor,projectId,{workerId,expectedRevision,input,idempotencyKey}){
   name(workerId);integer(expectedRevision,1);text(idempotencyKey);const inputJson=json(input),id=digest({projectId,idempotencyKey}),binding=digest({projectId,workerId,expectedRevision,inputJson});
   return store.transaction(async tx=>{await authorized(actor,'worker.run',projectId,tx);const old=await tx.read('worker-runs',id);if(old){requireThat(old.value.binding===binding,'idempotency_conflict');return output(old);}await admission(tx);const definition=await tx.read('project-workers',key(projectId,workerId));requireThat(definition?.revision===expectedRevision&&definition.value.enabled,'worker_unavailable');
    const c=await tx.read('worker-capacity','global'),capacity=c?.value??{total:0,active:[]};requireThat(capacity.total<WORKER_LIMITS.lifetime&&capacity.active.length<WORKER_LIMITS.activeGlobal,'worker_capacity_reached');
    for(const previous of capacity.active){const r=await tx.read('worker-runs',previous);requireThat(r?.value.projectId!==projectId,'worker_project_busy');}
    const day=Math.floor(now()/86400000);for(const [scope,limit]of [['global',WORKER_LIMITS.globalDaily],[projectId,WORKER_LIMITS.projectDaily]]){const k=scope+':'+day,r=await tx.read('worker-daily',k);requireThat((r?.value.count??0)<limit,'worker_daily_limit');await tx.write('worker-daily',k,{count:(r?.value.count??0)+1},r?.revision??0);}
    await tx.write('worker-capacity','global',{total:capacity.total+1,active:[...capacity.active,id]},c?.revision??0);
    return output(await tx.write('worker-runs',id,{id,projectId,workerId,actor,binding,definition:definition.value,definitionRevision:definition.revision,inputJson,state:'queued',createdAt:now()},0));
   });
  },
  async runGet(actor,projectId,runId){await authorized(actor,'worker.read',projectId);const r=await store.read('worker-runs',text(runId));requireThat(r?.value.projectId===projectId,'not_found');return output(r);},
  async cancel(actor,projectId,runId){return store.transaction(async tx=>{await authorized(actor,'worker.cancel',projectId,tx);const r=await tx.read('worker-runs',text(runId));requireThat(r?.value.projectId===projectId,'not_found');if(terminal.has(r.value.state))return output(r);return output(await tx.write('worker-runs',runId,{...r.value,cancelledAt:now()},r.revision));});},
  async tick(){const active=(await store.read('worker-capacity','global'))?.value.active??[];let processed=0;
   for(const id of active){const token=digest({id,at:now()});let work=await store.transaction(async tx=>{const r=await tx.read('worker-runs',id);if(!r||terminal.has(r.value.state)||r.value.lease?.until>now())return null;const recovering=r.value.state==='running';const next={...r.value,state:'running',lease:{token,until:now()+WORKER_LIMITS.leaseMs},startedAt:r.value.startedAt??now()};await tx.write('worker-runs',id,next,r.revision);return {...next,recovering};});if(!work)continue;processed++;
    const stillAllowed=async()=>{const current=(await store.read('worker-runs',id))?.value;if(!current||current.lease?.token!==token||current.cancelledAt!==undefined)return false;try{await admission(store);await authorized(work.actor,'worker.run',work.projectId);const def=await store.read('project-workers',key(work.projectId,work.workerId));return def?.value.enabled===true&&def.revision===work.definitionRevision;}catch{return false;}};
    const progress=async value=>store.transaction(async tx=>{const r=await tx.read('worker-runs',id);requireThat(r?.value.lease?.token===token&&r.value.cancelledAt===undefined,'worker_cancelled');await tx.write('worker-runs',id,{...r.value,progress:value},r.revision);});
    try{
     if(work.recovering){await ports.stop(work).catch(()=>{});await finish(id,token,{state:'unknown',error:'execution_outcome_unknown'});continue;}
     if(!await stillAllowed()){await finish(id,token,{state:'cancelled',error:'authority_or_definition_changed'});continue;}
     const files=await artifacts.get(work.projectId,work.definition.sourceHash);
     const result=await ports.execute(work,files,progress,stillAllowed);
     requireThat(result.exitCode===0,'worker_execution_failed');
     requireThat(typeof result.output==='string'&&Buffer.byteLength(result.output)<=WORKER_LIMITS.jsonBytes,'worker_invalid_output');JSON.parse(result.output);
     await finish(id,token,{state:await stillAllowed()?'completed':'cancelled',resultJson:result.output,provider:result.provider,exitCode:result.exitCode});
    }catch(e){await ports.stop(work).catch(()=>{});await finish(id,token,{state:e.code==='worker_cancelled'?'cancelled':e.code==='worker_execution_failed'?'failed':'unknown',error:['worker_cancelled','worker_execution_failed','worker_invalid_output'].includes(e.code)?e.code:'execution_outcome_unknown'});}
   }return{processed};
  }
 };
}
