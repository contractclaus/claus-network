import {digest,integer,requireThat,text} from '../shared/index.mjs';
import {createOciBuildPlan} from './build-plan.mjs';

// Builds have no wallet or deployment authority. Public-source consent is
// explicit because standard public GitHub runners expose build logs/artifacts.
export function createOciBuilds({store,identity,projects,jobs,artifacts,images=null,now=()=>Date.now(),ports={},enabled=false}) {
  const kind='oci-build-v1';
  const complete=new Set(['compiled','failed','cancelled','blocked']);
  async function owned(reader,projectId,id){const row=await reader.read('oci-builds',text(id));requireThat(row?.value.projectId===projectId,'not_found');return row;}
  const retryDelay=attempts=>Math.min(900000,30000*2**Math.min(5,Math.max(0,attempts-1)));
  const sourcePayload=(id,plan)=>{const value={buildId:id,plan,instructionAuthority:false};requireThat(Buffer.byteLength(JSON.stringify(value))<=3200000,'oci_source_too_large');return value;};
  async function visible(reader,row){
    const job=(await reader.read('workflow-jobs',row.value.id))?.value;
    const {actor,planHash,...value}=row.value;
    return {...value,state:job?.state==='cancelled'?'cancelled':value.state,revision:row.revision,nextCheckAt:job?.state==='waiting'?job.availableAt:null};
  }
  async function authorized(reader,v){return identity.allowed(v.actor,'build.compile',{projectId:v.projectId},reader);}
  return {
    discovery(){return {enabled:enabled&&typeof ports.dispatch==='function'&&typeof ports.inspect==='function',profile:kind,sourceVisibility:'explicit-public-snapshot',artifact:'OCI archive, compiled only',deployment:false,maxImageBytes:33554432,maxSourcePayloadBytes:3200000,projectBuildsPerWindow:2,projectConcurrentBuilds:1,globalBuildsPerWindow:2,windowSeconds:90000,artifactStorage:images?.enabled?'private-r2':'temporary-github',artifactRetentionDays:images?.enabled?null:1,downloadUrlSeconds:images?.enabled?60:null};},
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
      sourcePayload(id,plan);
      return store.transaction(async tx=>{
        await identity.authorize(actor,'build.compile',{projectId},tx);
        const old=await tx.read('oci-builds',id);if(old){requireThat(old.value.requestHash===requestHash,'idempotency_conflict');return visible(tx,old);}
        // Small, rolling admission for the initial standard-runner export lane.
        // Unknown executions retain a slot; they never become a free retry.
        const row=await tx.read('oci-capacity','standard'),active=[],busy=[];
        for(const entry of row?.value.entries??[]){
          const b=await tx.read('oci-builds',entry.id),j=await tx.read('workflow-jobs',entry.id);
          const pending=b&&!complete.has(b.value.state)&&j?.value.state!=='cancelled';
          if(entry.at>now()-90000000||pending)active.push(entry);
          if(pending)busy.push(entry);
        }
        if(active.length>=2||busy.some(x=>x.projectId===projectId)){
          const relevant=active.some(x=>x.projectId===projectId)?active.filter(x=>x.projectId===projectId):active;
          const retryAt=Math.max(now()+60000,Math.min(...relevant.map(x=>x.at+90000000)));
          throw Object.assign(Error('oci_build_capacity_reached'),{code:'oci_build_capacity_reached',retryAt});
        }
        const job=await jobs.enqueue(tx,{projectId,kind,idempotencyKey,payload:{buildId:id},authority:{actor}});
        requireThat(job.id===id,'oci_job_binding_mismatch');
        const value={id,projectId,snapshotId,dockerfile,requestHash,publishSource:true,actor,planId:plan.id,sourceHash:plan.sourceHash,state:'queued',createdAt:now(),artifactHash:null};
        const saved=await tx.write('oci-builds',id,value,0);
        await tx.write('oci-capacity','standard',{entries:[...active,{id,projectId,at:now()}]},row?.revision??0);
        return visible(tx,saved);
      });
    },
    async get(actor,projectId,id){await identity.authorize(actor,'artifact.read',{projectId});return visible(store,await owned(store,projectId,id));},
    async artifact(actor,projectId,id){
      await identity.authorize(actor,'artifact.read',{projectId});const v=(await owned(store,projectId,id)).value;requireThat(v.artifactHash,'build_not_complete');
      const result=await artifacts.get(projectId,v.artifactHash);
      if(result.storage?.state==='verified'){
        requireThat(images?.enabled,'oci_image_storage_unavailable');
        const download=await images.download(projectId,result);
        await identity.authorize(actor,'artifact.read',{projectId});
        return {...result,artifactAvailability:'available',download};
      }
      const expiresAt=Date.parse(result.artifact?.expiresAt);
      return {...result,artifactAvailability:result.storage?.state==='expired'?'expired':Number.isFinite(expiresAt)?expiresAt<=now()?'expired':'available':'unknown'};
    },
    async publicSource(id){
      const v=(await store.read('oci-builds',text(id)))?.value;
      requireThat(v?.publishSource===true&&await authorized(store,v),'not_found');
      const job=(await store.read('workflow-jobs',id))?.value;
      requireThat(job&&job.state!=='cancelled'&&job.state!=='blocked','not_found');
      // No source first becomes public without the separate submit opt-in.
      const published=await projects.publicSource(digest({projectId:v.projectId,id:v.snapshotId}));
      const plan=createOciBuildPlan({projectId:v.projectId,snapshotId:v.snapshotId,dockerfile:v.dockerfile,files:published.files});
      requireThat(plan.id===v.planId&&plan.sourceHash===v.sourceHash,'oci_plan_changed');
      return sourcePayload(id,plan);
    },
    async runOne(){
      if(typeof ports.inspect!=='function')return {idle:true,configured:false};
      const claim=await jobs.claim({kinds:[kind],leaseMs:images?.enabled?180000:90000});if(claim.idle)return claim;
      const v=(await owned(store,claim.job.projectId,claim.id)).value;
      const work={id:v.id,projectId:v.projectId,planId:v.planId,sourceHash:v.sourceHash};
      const blocked=()=>jobs.finish(claim,{state:'blocked',result:{error:'authorization_revoked'}},async tx=>{const r=await owned(tx,v.projectId,v.id);await tx.write('oci-builds',v.id,{...r.value,state:'blocked',error:'authorization_revoked'},r.revision);});
      const validate=async observation=>{
        requireThat(observation?.buildId===v.id&&['not_started','unknown','running','compiled','failed'].includes(observation.state),'oci_observation_invalid');
        if(observation.state==='not_started'||observation.observationProof)
          requireThat(typeof ports.verifyObservation==='function'&&await ports.verifyObservation(work,observation)===true,'oci_observation_unverified');
      };
      try{
        let observation;
        if(claim.mode==='dispatch'){
          if(!enabled||!await authorized(store,v))return await blocked();
          await jobs.beginEffect(claim,(_job,tx)=>authorized(tx,v));
          observation=await ports.dispatch(work);
        }else{
          observation=await ports.inspect(work);await validate(observation);
          if(observation.state==='not_started'){
            if(!enabled||!await authorized(store,v))return await blocked();
            await jobs.assertCurrent(claim);
            // Only signed evidence of no dispatch permits continuing this ID.
            // Custody's atomic phase transition still enforces one external call.
            observation=await ports.dispatch(work);
          }
        }
        await validate(observation);
        if(observation.state==='compiled'){
          const receipt=observation.receipt;
          requireThat(receipt?.planId===v.planId&&receipt.sourceHash===v.sourceHash&&receipt.projectId===v.projectId&&receipt.buildId===v.id&&receipt.evidence==='compiled_only','oci_receipt_mismatch');
          requireThat(/^sha256:[a-f0-9]{64}$/.test(receipt.imageDigest)&&/^sha256:[a-f0-9]{64}$/.test(receipt.archiveHash),'oci_receipt_invalid');
          integer(receipt.archiveBytes,1,33554432);
          requireThat(typeof ports.verify==='function'&&await ports.verify(receipt,observation)===true,'oci_receipt_unverified');
          if(images?.enabled&&await authorized(store,v)){
            await jobs.assertCurrent(claim);
            let storage;
            try{storage=await images.preserve(v.projectId,receipt,()=>ports.download(work,receipt));}
            catch(error){if(error.code!=='oci_result_expired')throw error;storage={state:'expired',archiveHash:receipt.archiveHash};}
            observation={...observation,receipt:{...receipt,storage}};
            await jobs.assertCurrent(claim);
          }
        }
        const final=['compiled','failed'].includes(observation.state);
        const retryAt=final?null:now()+(observation.state==='running'?60000:retryDelay(claim.job.attempts));
        return await jobs.finish(claim,{state:final?observation.state==='compiled'?'complete':'failed':'waiting',result:{state:observation.state,error:observation.error??null},retryAt},async tx=>{
          const r=await owned(tx,v.projectId,v.id),allowed=await authorized(tx,r.value);
          const artifactHash=observation.state==='compiled'&&allowed?await artifacts.put(tx,v.projectId,observation.receipt):null;
          await tx.write('oci-builds',v.id,{...r.value,state:final&&!allowed?'blocked':observation.state,artifactHash,runUrl:observation.runUrl??r.value.runUrl??null,error:observation.error??null,...(final?{completedAt:now()}:{}),observedAt:now()},r.revision);
        });
      }catch(error){
        if(error.code==='lease_lost')return {stale:true};
        const code=/^oci_[a-z0-9_]+$/.test(error.code??'')?error.code:'oci_outcome_unknown';
        try{return await jobs.finish(claim,{state:'waiting',result:{state:'unknown',error:code},retryAt:now()+retryDelay(claim.job.attempts)},async tx=>{const r=await owned(tx,v.projectId,v.id);await tx.write('oci-builds',v.id,{...r.value,state:'unknown',error:code,observedAt:now()},r.revision);});}
        catch(finishError){if(finishError.code==='lease_lost')return {stale:true};throw finishError;}
      }
    }
  };
}
