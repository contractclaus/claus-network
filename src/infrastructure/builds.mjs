import {copy,digest,integer,requireThat,text} from '../shared/index.mjs';
import {createOciBuildPlan} from './build-plan.mjs';

// Builds have no wallet or deployment authority. Public-source consent is
// explicit because standard public GitHub runners expose build logs/artifacts.
export function createOciBuilds({store,identity,projects,jobs,artifacts,now=()=>Date.now(),ports={},enabled=false}) {
  const kind='oci-build-v1';
  const complete=new Set(['compiled','failed','cancelled','blocked']);
  async function owned(reader,projectId,id){const row=await reader.read('oci-builds',text(id));requireThat(row?.value.projectId===projectId,'not_found');return row;}
  async function visible(reader,row){
    const job=(await reader.read('workflow-jobs',row.value.id))?.value;
    const {actor,planHash,...value}=row.value;
    return {...value,state:job?.state==='cancelled'?'cancelled':value.state,revision:row.revision};
  }
  async function authorized(reader,v){return identity.allowed(v.actor,'build.compile',{projectId:v.projectId},reader);}
  return {
    discovery(){return {enabled:enabled&&typeof ports.dispatch==='function'&&typeof ports.inspect==='function',profile:kind,sourceVisibility:'explicit-public-snapshot',artifact:'OCI archive, compiled only',deployment:false,maxImageBytes:33554432};},
    async submit(actor,projectId,{snapshotId,dockerfile='Dockerfile',publishSource,idempotencyKey}){
      await identity.authorize(actor,'build.compile',{projectId});
      text(idempotencyKey);requireThat(idempotencyKey.length<=128,'invalid_identifier');
      requireThat(publishSource===true,'oci_public_source_consent_required');
      const id=digest({projectId,kind,idempotencyKey}),requestHash=digest({snapshotId,dockerfile,publishSource});
      const prior=await store.read('oci-builds',id);
      if(prior){requireThat(prior.value.requestHash===requestHash,'idempotency_conflict');return visible(store,prior);}
      requireThat(enabled&&typeof ports.dispatch==='function'&&typeof ports.inspect==='function','oci_builds_not_enabled');
      const published=await projects.publicSource(digest({projectId,id:snapshotId}));
      requireThat(published.projectId===projectId&&published.snapshotId===snapshotId,'oci_source_not_public');
      const plan=createOciBuildPlan({projectId,snapshotId,dockerfile,files:published.files});
      return store.transaction(async tx=>{
        await identity.authorize(actor,'build.compile',{projectId},tx);
        const old=await tx.read('oci-builds',id);if(old){requireThat(old.value.requestHash===requestHash,'idempotency_conflict');return visible(tx,old);}
        // Small, rolling admission for the initial standard-runner export lane.
        // Unknown executions retain a slot; they never become a free retry.
        const row=await tx.read('oci-capacity','standard'),active=[];
        for(const entry of row?.value.entries??[]){
          const b=await tx.read('oci-builds',entry.id),j=await tx.read('workflow-jobs',entry.id);
          if(entry.at>now()-90000000||b&&!complete.has(b.value.state)&&j?.value.state!=='cancelled')active.push(entry);
        }
        requireThat(active.length<2&&!active.some(x=>x.projectId===projectId),'oci_build_capacity_reached');
        const job=await jobs.enqueue(tx,{projectId,kind,idempotencyKey,payload:{buildId:id},authority:{actor}});
        requireThat(job.id===id,'oci_job_binding_mismatch');
        const value={id,projectId,snapshotId,dockerfile,requestHash,publishSource:true,actor,planId:plan.id,sourceHash:plan.sourceHash,state:'queued',createdAt:now(),artifactHash:null};
        const saved=await tx.write('oci-builds',id,value,0);
        await tx.write('oci-capacity','standard',{entries:[...active,{id,projectId,at:now()}]},row?.revision??0);
        return visible(tx,saved);
      });
    },
    async get(actor,projectId,id){await identity.authorize(actor,'artifact.read',{projectId});return visible(store,await owned(store,projectId,id));},
    async artifact(actor,projectId,id){await identity.authorize(actor,'artifact.read',{projectId});const v=(await owned(store,projectId,id)).value;requireThat(v.artifactHash,'build_not_complete');return artifacts.get(projectId,v.artifactHash);},
    async publicSource(id){
      const v=(await store.read('oci-builds',text(id)))?.value;
      requireThat(v?.publishSource===true&&await authorized(store,v),'not_found');
      const job=(await store.read('workflow-jobs',id))?.value;
      requireThat(job&&job.state!=='cancelled'&&job.state!=='blocked','not_found');
      // No source first becomes public without the separate submit opt-in.
      const published=await projects.publicSource(digest({projectId:v.projectId,id:v.snapshotId}));
      const plan=createOciBuildPlan({projectId:v.projectId,snapshotId:v.snapshotId,dockerfile:v.dockerfile,files:published.files});
      requireThat(plan.id===v.planId&&plan.sourceHash===v.sourceHash,'oci_plan_changed');
      return {buildId:id,plan,instructionAuthority:false};
    },
    async runOne(){
      // Turning off new admission must not suppress old outcome reconciliation.
      if(typeof ports.inspect!=='function')return {idle:true,configured:false};
      const claim=await jobs.claim({kinds:[kind],leaseMs:90000});if(claim.idle)return claim;
      const v=(await owned(store,claim.job.projectId,claim.id)).value;
      try{
        let observation;
        if(claim.mode==='dispatch'){
          if(!enabled||!await authorized(store,v))return jobs.finish(claim,{state:'blocked',result:{error:'authorization_revoked'}},async tx=>{const r=await owned(tx,v.projectId,v.id);await tx.write('oci-builds',v.id,{...r.value,state:'blocked'},r.revision);});
          await jobs.beginEffect(claim,(_job,tx)=>authorized(tx,v));
          observation=await ports.dispatch({id:v.id,projectId:v.projectId,planId:v.planId,sourceHash:v.sourceHash});
        }else observation=await ports.inspect({id:v.id,projectId:v.projectId,planId:v.planId,sourceHash:v.sourceHash});
        requireThat(observation?.buildId===v.id&&['unknown','running','compiled','failed'].includes(observation.state),'oci_observation_invalid');
        if(observation.state==='compiled'){
          const receipt=observation.receipt;
          requireThat(receipt?.planId===v.planId&&receipt.sourceHash===v.sourceHash&&receipt.projectId===v.projectId&&receipt.buildId===v.id&&receipt.evidence==='compiled_only','oci_receipt_mismatch');
          requireThat(/^sha256:[a-f0-9]{64}$/.test(receipt.imageDigest)&&/^sha256:[a-f0-9]{64}$/.test(receipt.archiveHash),'oci_receipt_invalid');
          integer(receipt.archiveBytes,1,33554432);
          requireThat(typeof ports.verify==='function'&&await ports.verify(receipt,observation)===true,'oci_receipt_unverified');
        }
        const final=['compiled','failed'].includes(observation.state);
        return jobs.finish(claim,{state:final?observation.state==='compiled'?'complete':'failed':'waiting',result:{state:observation.state},retryAt:final?null:now()+60000},async tx=>{
          const r=await owned(tx,v.projectId,v.id);
          // Revocation prevents publishing an output, but never hides an
          // already dispatched execution or removes its reconciliation slot.
          const allowed=await authorized(tx,r.value);
          const artifactHash=observation.state==='compiled'&&allowed?await artifacts.put(tx,v.projectId,observation.receipt):null;
          await tx.write('oci-builds',v.id,{...r.value,state:final&&!allowed?'blocked':observation.state,artifactHash,runUrl:observation.runUrl??null,error:observation.error??null,...(final?{completedAt:now()}:{}),observedAt:now()},r.revision);
        });
      }catch(error){
        if(error.code==='lease_lost')return {stale:true};
        return jobs.finish(claim,{state:'waiting',result:{state:'unknown'},retryAt:now()+60000},async tx=>{const r=await owned(tx,v.projectId,v.id);await tx.write('oci-builds',v.id,{...r.value,state:'unknown',error:'oci_outcome_unknown',observedAt:now()},r.revision);});
      }
    }
  };
}
