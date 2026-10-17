import {digest,requireThat,text,integer,sourceText} from '../shared/index.mjs';
import {validateManifest} from './manifest.mjs';
import {CLAUS_IDENTITY} from '../partner-launch/policy.mjs';
export const RUNTIME_IMAGE_PROFILE='claus-runtime-image-v1';
export const OWNER_RUNTIME_REVIEW_PROFILE='claus-owner-search-review-v1';
export const OWNER_SEARCH_PROJECT='prj_de70d4aa-0804-4a94-8097-7a9a34f0a28a';
export const runtimeEndorsement=v=>'CLAUS_RUNTIME_IMAGE_APPROVED:'+digest(v);
export function validateRuntimeBuild(v){requireThat(v?.evidence==='compiled_only'&&v.storage?.state==='verified'&&/^sha256:[a-f0-9]{64}$/.test(v.imageDigest??''),'runtime_image_build_unverified');}
export function createRuntimeReleases({store,identity,projects,artifacts,origin,now=()=>Date.now()}){
 const host=new URL(origin).host,read=async(r,c,id)=>(await r.read(c,id))?.value;
 async function authority(actor,r){const c=await identity.credential(actor,r),p=await read(r,'principals',c.principalId);requireThat(c.kind==='owner'&&p?.chainId===1&&p.address?.toLowerCase()===CLAUS_IDENTITY,'runtime_image_claus_required');return c.principalId;}
 async function build(r,projectId,buildId){
  const b=await read(r,'oci-builds',buildId),p=await read(r,'projects',projectId);
  requireThat(p&&!p.archivedAt&&!p.transfer&&!(await read(r,'project-access',projectId))?.suspended,'runtime_image_project_unavailable');
  requireThat(b?.projectId===projectId&&b.state==='compiled'&&b.publishSource===true&&b.registry?.enabled===true,'runtime_image_unavailable');
  requireThat(await (identity.publishedBuildAllowed?identity.publishedBuildAllowed(b.actor,projectId,r):identity.allowed(b.actor,'build.compile',{projectId},r)),'runtime_image_unavailable');
  const job=await read(r,'workflow-jobs',buildId),source=await read(r,'public-sources',digest({projectId,id:b.snapshotId}));
  requireThat(job?.state==='complete'&&source?.published===true,'runtime_image_unavailable');
  const receipt=await artifacts.get(projectId,b.artifactHash,r);validateRuntimeBuild(receipt);
  requireThat(receipt.buildId===buildId&&receipt.projectId===projectId&&receipt.planId===b.planId&&receipt.sourceHash===b.sourceHash&&receipt.imageDigest===b.registry.imageDigest&&receipt.archiveHash===b.registry.archiveHash,'runtime_image_build_unverified');
  return {ownerId:p.ownerId,build:b,image:`${host}/claus/${buildId.slice(7)}@${receipt.imageDigest}`};
 }
 async function bound(r,projectId,id){
  const v=await read(r,'runtime-image-releases',id);requireThat(v?.projectId===projectId,'not_found');
  const b=await build(r,projectId,v.buildId);requireThat(b.ownerId===v.ownerId&&b.image===v.manifest.image&&b.build.artifactHash===v.buildHash&&b.build.snapshotId===v.sourceHash,'runtime_image_changed');return v;
 }
 const context=v=>({profile:RUNTIME_IMAGE_PROFILE,releaseId:v.id,projectId:v.projectId,buildId:v.buildId,buildHash:v.buildHash,sourceHash:v.sourceHash,manifest:v.manifest});
 // This explicitly labelled owner policy applies only to the existing Search
 // service. It neither substitutes for an IMD report nor admits other projects.
 async function ownerBound(r,projectId,id){
  requireThat(projectId===OWNER_SEARCH_PROJECT,'runtime_image_owner_scope_denied');
  const v=await bound(r,projectId,id),owner=await read(r,'principals',v.ownerId),m=v.manifest;
  requireThat(owner?.chainId===1&&owner.address?.toLowerCase()===CLAUS_IDENTITY,'runtime_image_owner_scope_denied');
  requireThat(m.mode==='model'&&m.cpu<=2&&m.memoryMiB<=4096&&m.gpu===null&&m.storageGiB===0&&m.port===8080&&m.healthPath==='/health'&&m.command.length===0,'runtime_image_owner_scope_denied');
  return v;
 }
 const ownerReviewCore=(v,reportHash,findings)=>({profile:OWNER_RUNTIME_REVIEW_PROFILE,context:context(v),reportHash,findings});
 async function ownerEvidence(r,projectId,id,reviewId){
  const v=await ownerBound(r,projectId,id),report=await read(r,'runtime-owner-reviews',text(reviewId));
  requireThat(report?.profile===OWNER_RUNTIME_REVIEW_PROFILE&&report.published===true&&report.independent===false&&typeof report.report==='string'&&report.reportHash===digest(report.report)&&Array.isArray(report.findings)&&digest(report.context)===digest(context(v))&&report.id===digest(ownerReviewCore(v,report.reportHash,report.findings)),'runtime_image_owner_review_incomplete');
  requireThat(report.findings.every(f=>['low','info'].includes(f.severity)),'runtime_image_blocking_review');
  return {release:v,review:{profile:OWNER_RUNTIME_REVIEW_PROFILE,reviewId:report.id,reportHash:report.reportHash},findings:report.findings,findingHashes:report.findings.map(digest),report:report.report,independent:false};
 }
 async function evidence(r,projectId,releaseId,caseId){
  const v=await bound(r,projectId,releaseId),review=await read(r,'review-cases',caseId);
  requireThat(review?.projectId===projectId&&review.profile===RUNTIME_IMAGE_PROFILE&&review.state==='reviewed'&&digest(review.input)===review.inputHash&&digest(review.input.runtimeImage)===digest(context(v)),'runtime_image_review_incomplete');
  const job=await read(r,'review-jobs',review.reviewJobId);
  requireThat(job?.work==='completed'&&job.billing==='settled'&&job.inputHash===review.inputHash,'runtime_image_review_incomplete');
  requireThat(review.sourceBinding?.inputHash===review.inputHash&&review.sourceBinding.sourceHash===v.sourceHash&&review.sourceBinding.repository===review.input.repoUrl&&review.sourceBinding.commit===review.input.baseCommit,'runtime_image_source_unverified');
  requireThat((await read(r,'review-publications',caseId))?.published===true,'runtime_image_review_not_public');
  const report=await artifacts.get(projectId,review.artifactHash,r),s=report.submissions;
  requireThat(report.complete===true&&report.jobId===review.providerJobId&&typeof report.report==='string'&&s?.repoUrl===review.input.repoUrl&&s.baseCommit===review.input.baseCommit&&Array.isArray(s.submissions),'runtime_image_review_incomplete');
  const judges=s.submissions.filter(x=>x.nodeKey==='audit_judge'&&x.accepted===true),j=judges[0];
  requireThat(judges.length===1&&j.role==='review'&&j.outcome==='completed'&&j.safetyRefusal===false&&j.verificationErrors===0&&j.baseCommit===s.baseCommit&&/^[a-f0-9]{64}$/.test(j.hash??'')&&Array.isArray(j.findings)&&j.findings.every(f=>['low','info','informational'].includes(f.severity))&&s.submissions.every(x=>!x.accepted||x.baseCommit===s.baseCommit),'runtime_image_blocking_review');
  requireThat(typeof j.summary==='string'&&j.summary.split(/\r?\n/).filter(x=>x.trim()===runtimeEndorsement(context(v))).length===1,'runtime_image_endorsement_missing');
  return {release:v,review:{caseId,artifactHash:review.artifactHash,reportHash:digest(report.report),judgeHash:j.hash},findings:j.findings,findingHashes:j.findings.map(digest)};
 }
 return {
  async ownerReview(actor,projectId,id,{report,findingsJson,published}){
   sourceText(report,32000);sourceText(findingsJson,16000);
   requireThat(report.trim().length>=200&&published===true,'runtime_image_owner_review_invalid');
   let findings;try{findings=JSON.parse(findingsJson);}catch{requireThat(false,'runtime_image_owner_review_invalid');}
   requireThat(Array.isArray(findings)&&findings.length<=50,'runtime_image_owner_review_invalid');
   for(const f of findings){
    requireThat(f&&Object.keys(f).length===3&&['info','low','medium','high','critical'].includes(f.severity)&&typeof f.title==='string'&&typeof f.description==='string','runtime_image_owner_review_invalid');
    sourceText(f.title,256);sourceText(f.description,4000);requireThat(f.title.trim().length>0&&f.description.trim().length>0,'runtime_image_owner_review_invalid');
   }
   return store.transaction(async r=>{
    const submittedBy=await authority(actor,r),v=await ownerBound(r,projectId,id),core=ownerReviewCore(v,digest(report),findings),reviewId=digest(core),old=await read(r,'runtime-owner-reviews',reviewId);
    if(old)return old;
    const value={...core,id:reviewId,report,independent:false,published:true,authorship:'owner_operator',submittedBy,createdAt:now()};
    await r.write('runtime-owner-reviews',reviewId,value,0);return value;
   });
  },
  async ownerInspect(actor,projectId,id,reviewId){await authority(actor,store);return ownerEvidence(store,projectId,id,reviewId);},
  async publicOwnerReview(id){const row=await read(store,'runtime-owner-reviews',text(id));requireThat(row?.published===true,'not_found');return {...row,instructionAuthority:false};},
  async ownerApprove(actor,projectId,id,{reviewId,reportHash,acknowledgedFindings,reason,expectedRevision}){
   integer(expectedRevision);sourceText(reason,4000);requireThat(reason.trim().length>=20&&Array.isArray(acknowledgedFindings),'runtime_image_decision_invalid');
   return store.transaction(async r=>{
    await authority(actor,r);const row=await r.read('runtime-image-releases',id);requireThat(row?.revision===expectedRevision,'revision_conflict');
    const e=await ownerEvidence(r,projectId,id,reviewId);
    requireThat(reportHash===e.review.reportHash&&digest([...acknowledgedFindings].sort())===digest(e.findingHashes.sort()),'runtime_image_decision_invalid');
    const value={...e.release,approved:true,decision:{review:e.review,reason,at:now()}},saved=await r.write('runtime-image-releases',id,value,expectedRevision);
    return {...value,revision:saved.revision};
   });
  },
  async prepare(actor,projectId,{buildId,manifest}){
   await identity.authorize(actor,'infrastructure.manage',{projectId});
   requireThat(manifest&&!Object.hasOwn(manifest,'releaseHash'),'runtime_image_manifest_invalid');
   const m=validateManifest({...manifest,releaseHash:'sha256:'+'0'.repeat(64)});delete m.releaseHash;requireThat(m.storageGiB===0,'runtime_image_manifest_invalid');
   return store.transaction(async r=>{await identity.authorize(actor,'infrastructure.manage',{projectId},r);const b=await build(r,projectId,buildId);requireThat(m.image===b.image,'runtime_image_changed');
    const core={profile:RUNTIME_IMAGE_PROFILE,projectId,ownerId:b.ownerId,buildId,buildHash:b.build.artifactHash,sourceHash:b.build.snapshotId,manifest:m},id=digest(core),old=await r.read('runtime-image-releases',id);
    if(old)return {...old.value,revision:old.revision};
    const value={...core,id,manifest:{...m,releaseHash:id},createdAt:now(),approved:false};const saved=await r.write('runtime-image-releases',id,value,0);return {...value,revision:saved.revision};});
  },
  async select(r,projectId,{actor,chainId,runtimeReleaseId}){requireThat(chainId===undefined,'unsupported_chain');await identity.authorize(actor,'review.quote',{projectId},r);await bound(r,projectId,text(runtimeReleaseId));return {profile:RUNTIME_IMAGE_PROFILE};},
  async input(actor,projectId,releaseId,buildId){await identity.authorize(actor,'review.quote',{projectId});const v=await bound(store,projectId,releaseId);requireThat(v.buildId===buildId,'runtime_image_changed');const b=await read(store,'oci-builds',buildId);return {build:{...b,entry:b.dockerfile},runtimeImage:context(v)};},
  async get(actor,projectId,id){try{await identity.authorize(actor,'infrastructure.read',{projectId});}catch{await authority(actor,store);}const row=await store.read('runtime-image-releases',id);requireThat(row?.value.projectId===projectId,'not_found');return {...row.value,revision:row.revision};},
  async inspect(actor,projectId,id,caseId){await authority(actor,store);return evidence(store,projectId,id,caseId);},
  async approve(actor,projectId,id,{caseId,reportHash,acknowledgedFindings,reason,expectedRevision}){
   integer(expectedRevision);sourceText(reason,4000);requireThat(reason.trim().length>=20&&reason.length<=4000&&Array.isArray(acknowledgedFindings),'runtime_image_decision_invalid');
   return store.transaction(async r=>{await authority(actor,r);const row=await r.read('runtime-image-releases',id);requireThat(row?.revision===expectedRevision,'revision_conflict');const e=await evidence(r,projectId,id,caseId);
    requireThat(reportHash===e.review.reportHash&&digest([...acknowledgedFindings].sort())===digest(e.findings.map(digest).sort()),'runtime_image_decision_invalid');
    const value={...e.release,approved:true,decision:{review:e.review,reason,at:now()}};const saved=await r.write('runtime-image-releases',id,value,expectedRevision);return {...value,revision:saved.revision};});
  },
  async revoke(actor,projectId,id,{expectedRevision}){integer(expectedRevision);return store.transaction(async r=>{try{await identity.authorize(actor,'infrastructure.manage',{projectId},r);}catch{await authority(actor,r);}const row=await r.read('runtime-image-releases',id);requireThat(row?.value.projectId===projectId,'not_found');const value={...row.value,approved:false,revokedAt:now()};const saved=await r.write('runtime-image-releases',id,value,expectedRevision);return {...value,revision:saved.revision};});},
  async status(id){
   const row=await read(store,'runtime-image-releases',text(id));if(!row?.approved)return {approved:false,releaseId:id};
   try{const e=row.decision.review.profile===OWNER_RUNTIME_REVIEW_PROFILE?await ownerEvidence(store,row.projectId,id,row.decision.review.reviewId):await evidence(store,row.projectId,id,row.decision.review.caseId);requireThat(digest(e.review)===digest(row.decision.review),'runtime_image_changed');return {approved:true,releaseId:id,projectId:row.projectId,manifestHash:digest(row.manifest),image:row.manifest.image,reviewHash:digest(e.review),decisionHash:digest(row.decision),reviewType:e.review.profile??RUNTIME_IMAGE_PROFILE};}
   catch(e){if(e.code==='not_found'||e.code?.startsWith('runtime_image_'))return {approved:false,releaseId:id};throw e;}
  }
 };
}
