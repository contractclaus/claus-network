import {copy,digest,integer,requireThat,shape,text} from '../shared/index.mjs';

export const WORKFLOW_LIMITS=Object.freeze({steps:8,runs:1000,minimumIntervalSeconds:60,lifetimeMs:30*86400000,perProject:100,tick:4});
const value=row=>({...copy(row.value),revision:row.revision});
const failures=new Set(['scope_denied','app_membership_required','project_unavailable','not_found','app_schema_migration_required','workflow_inactive','workflow_step_changed']);

export function createWorkflows({store,identity,apps,now=()=>Date.now(),admit=async()=>{}}){
  async function authorize(actor,projectId,reader=store,withdrawal=false){await identity.authorize(actor,withdrawal?'workflow.cancel':'workflow.manage',{projectId},reader);return identity.credential(actor,reader);}
  async function active(row,reader=store){
    requireThat(row.state==='active'&&row.expiresAt>now(),'workflow_inactive');
    const p=(await reader.read('projects',row.projectId))?.value;
    requireThat(p&&!p.archivedAt&&!p.transfer&&p.ownerId===row.ownerId,'workflow_inactive');
    if(row.mandateId){const m=(await reader.read('mandates',row.mandateId))?.value;requireThat(m&&!m.revokedAt&&m.expiresAt>now()&&m.projectId===row.projectId&&m.principalId===row.authorId&&m.ownerId===row.ownerId&&m.scopes.includes('workflow.manage')&&m.scopes.includes('app.use'),'workflow_inactive');}
    await admit(row.projectId,reader);
  }
  const api={limits:WORKFLOW_LIMITS,
    // Host-only grant validation runs again inside the app transaction. Its
    // FOR SHARE network read serializes cancellation against task creation.
    async postingAuthority(reader,ref,appId,input){
      const row=(await reader.read('app-workflows',ref.workflowId))?.value;requireThat(row,'workflow_inactive');await active(row,reader);
      requireThat(row.run===ref.run&&row.step===ref.step&&row.pending?.inputHash===digest(input)&&row.steps[row.step]?.appId===appId,'workflow_step_changed');
      return {principalId:row.authorId,schemaHash:row.steps[row.step].schemaHash};
    },
    async create(actor,projectId,{name,steps,intervalSeconds,maxRuns,expiresAt,idempotencyKey}){
      text(name);requireThat(name.length<=80,'invalid_workflow_name');text(idempotencyKey);requireThat(idempotencyKey.length<=128,'invalid_idempotency_key');
      integer(intervalSeconds,60,30*86400);integer(maxRuns,1,1000);integer(expiresAt);
      requireThat(Array.isArray(steps)&&steps.length>0&&steps.length<=8,'invalid_workflow_steps');
      const who=await authorize(actor,projectId);if(who.kind!=='owner')await identity.authorize(actor,'app.use',{projectId});
      const id=digest({projectId,idempotencyKey,kind:'app-workflow'}),requestHash=digest({name,steps,intervalSeconds,maxRuns,expiresAt});
      const previous=await store.read('app-workflows',id);if(previous){requireThat(previous.value.requestHash===requestHash,'idempotency_conflict');return value(previous);}
      integer(expiresAt,now()+60000,now()+WORKFLOW_LIMITS.lifetimeMs);
      const clean=[];let outputSchema;
      for(const [i,s] of steps.entries()){
        shape(s,s.from==='previous'?['appId','from']:['appId','from','input']);text(s.appId);requireThat(s.from==='fixed'||i>0&&s.from==='previous','invalid_workflow_steps');
        const info=await apps.workflowTarget(actor,s.appId,s.from==='fixed'?{input:s.input}:{});
        if(s.from==='previous')requireThat(digest(outputSchema)===digest(info.inputSchema),'invalid_workflow_schema_chain');
        clean.push({...copy(s),schemaHash:info.schemaHash});outputSchema=info.outputSchema;
      }
      return store.transaction(async tx=>{
        const caller=await authorize(actor,projectId,tx);await admit(projectId,tx);const p=(await tx.read('projects',projectId)).value;
        requireThat(caller.principalId===who.principalId,'scope_denied');
        const old=await tx.read('app-workflows',id);if(old){requireThat(old.value.requestHash===requestHash,'idempotency_conflict');return value(old);}
        if(caller.kind!=='owner'){await identity.authorize(actor,'app.use',{projectId},tx);requireThat(expiresAt<=caller.expiresAt,'binding_exceeds_authority');}
        const usage=await tx.read('workflow-capacity',projectId);requireThat((usage?.value.count??0)<WORKFLOW_LIMITS.perProject,'capacity_reached');
        const row={id,projectId,name,steps:clean,intervalSeconds,maxRuns,expiresAt,requestHash,ownerId:p.ownerId,authorId:caller.principalId,
          mandateId:caller.kind==='owner'?null:caller.mandateId,state:'active',run:0,step:0,completedRuns:0,pending:null,nextAt:now(),createdAt:now(),updatedAt:now()};
        await tx.write('workflow-capacity',projectId,{count:(usage?.value.count??0)+1},usage?.revision??0);
        return value(await tx.write('app-workflows',id,row,0));
      });
    },
    async get(actor,projectId,id){await identity.authorize(actor,'project.read',{projectId});const row=await store.read('app-workflows',text(id));requireThat(row?.value.projectId===projectId,'not_found');return value(row);},
    async list(actor,projectId,{after='',limit=25}={}){await identity.authorize(actor,'project.read',{projectId});integer(limit,1,50);const rows=await store.list('app-workflows',{projectId,after,limit});return {items:rows.map(value),nextCursor:rows.length===limit?rows.at(-1).id:null};},
    async cancel(actor,projectId,id,{expectedRevision}){return store.transaction(async tx=>{
      await authorize(actor,projectId,tx,true);const row=await tx.read('app-workflows',text(id));requireThat(row?.value.projectId===projectId,'not_found');
      if(row.value.state==='cancelled')return value(row);requireThat(row.revision===expectedRevision,'revision_conflict');
      return value(await tx.write('app-workflows',id,{...row.value,state:'cancelled',updatedAt:now(),leaseUntil:null},row.revision));
    });},
    async receipts(actor,projectId,id,{after='',limit=25}={}){await api.get(actor,projectId,id);integer(limit,1,50);const rows=await store.list('workflow-runs',{prefix:id+':',after,limit});return {items:rows.map(value),nextCursor:rows.length===limit?rows.at(-1).id:null};},
    async tick({limit=4}={}){integer(limit,1,4);requireThat(apps.enabled,'apps_not_enabled');const started=now(),rows=await store.dueWorkflows({at:started,limit}),results=[];
      for(const row of rows){try{results.push(await api.advance(row.id));}catch(e){results.push({id:row.id,state:'retry',error:e.code??'unavailable'});}}
      return {observedAt:now(),processed:results.length,results};
    },
    async advance(id){
      const claimed=await store.transaction(async tx=>{
        const old=await tx.read('app-workflows',id);if(!old||old.value.state!=='active'||old.value.nextAt>now()||old.value.leaseUntil>now())return null;
        const w=copy(old.value);
        if(w.expiresAt<=now()){w.state='expired';w.updatedAt=now();await tx.write('app-workflows',id,w,old.revision);return null;}
        try{await active(w,tx);}catch(e){if(failures.has(e.code)){w.state='blocked';w.error=e.code;w.updatedAt=now();await tx.write('app-workflows',id,w,old.revision);return null;}throw e;}
        w.leaseGeneration=(w.leaseGeneration??0)+1;w.leaseUntil=now()+120000;w.nextAt=w.leaseUntil;
        if(!w.pending){const input=w.steps[w.step].from==='previous'?w.previousOutput:w.steps[w.step].input;w.pending={input:copy(input),inputHash:digest(input),taskId:null};}
        await tx.write('app-workflows',id,w,old.revision);return w;
      });
      if(!claimed)return {id,state:'idle'};const w=claimed,s=w.steps[w.step];let task,error;
      try{
        if(!w.pending.taskId)task=await apps.postWorkflowTask({workflowId:id,run:w.run,step:w.step},s.appId,w.pending.input);
        else task=await apps.workflowTask(s.appId,w.pending.taskId,s.schemaHash);
      }catch(e){error=e.code??'unavailable';}
      return store.transaction(async tx=>{
        const row=await tx.read('app-workflows',id);if(row?.value.state!=='active'||row.value.leaseGeneration!==w.leaseGeneration)return {id,state:row?.value.state??'idle'};
        const next=copy(row.value);next.leaseUntil=null;next.nextAt=now()+60000;next.updatedAt=now();
        if(error){next.error=error;if(failures.has(error))next.state='blocked';}
        else {
          next.error=null;next.pending.taskId=task.id;
          if(task.state==='cancelled')next.state='blocked';
          if(task.state==='accepted'){
            const key=id+':'+String(w.run).padStart(6,'0')+':'+String(w.step).padStart(2,'0');
            if(!await tx.read('workflow-runs',key))await tx.write('workflow-runs',key,{projectId:w.projectId,workflowId:id,run:w.run,step:w.step,appId:s.appId,taskId:task.id,receipt:task.receipt??null,outputHash:task.outputHash,observedAt:now()},0);
            next.pending=null;next.previousOutput=copy(task.output);next.step++;
            if(next.step===next.steps.length){next.completedRuns++;next.run++;next.step=0;delete next.previousOutput;next.nextAt=now()+next.intervalSeconds*1000;if(next.completedRuns>=next.maxRuns)next.state='completed';}
            else next.nextAt=now();
          }
        }
        await tx.write('app-workflows',id,next,row.revision);return {id,state:next.state,run:next.run,step:next.step,taskId:next.pending?.taskId??null,error:next.error??null};
      });
    }
  };return api;
}
