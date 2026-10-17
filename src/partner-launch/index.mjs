import {createSourceFiles} from '../artifact-store/index.mjs';
import { digest, requireThat, shape, contentHash } from '../shared/index.mjs';
import { PROFILE, PROFILE_ID, CLAUS_IDENTITY, context, assignment, bindAssignment, validateRequest, endorsement } from './policy.mjs';
import { validateCapitalBuild } from '../capital/review.mjs';

export function createPartnerLaunches({store, identity, builds, artifacts, sourceFiles = createSourceFiles({store}), pins, now = Date.now}) {
  const trusted = assignment(pins);
  const read = async (reader, collection, id) => (await reader.read(collection,id))?.value;
  async function party(reader, v) {
    bindAssignment(v,trusted,now());
    const p=await read(reader,'projects',v.projectId), owner=p && await read(reader,'principals',p.ownerId);
    requireThat(p && !p.archivedAt && !p.transfer && owner?.chainId===1 && owner.address?.toLowerCase()===v.ownerAddress,
      'partner_project_owner_changed');
    requireThat(!(await read(reader,'project-access',v.projectId))?.suspended,'partner_project_suspended');
    return {project:p,owner};
  }
  async function authority(actor, reader) {
    const c=await identity.credential(actor,reader),p=await read(reader,'principals',c.principalId);
    requireThat(c.kind==='owner' && p?.chainId===1 && p.address?.toLowerCase()===CLAUS_IDENTITY,'partner_claus_decision_required');
  }
  async function requestSource(reader,v,snapshotId) {
    const snapshot=await read(reader,'snapshots',digest({projectId:v.projectId,id:snapshotId}));
    const file=snapshot?.files?.find(f=>f.path===v.requestFile);
    const stored=file && await sourceFiles.get(v.projectId,file.hash,reader);
    requireThat(stored?.path===v.requestFile && digest({path:stored.path,content:stored.content})===file.hash,'partner_request_source_missing');
    return validateRequest(stored.content,v);
  }
  async function evidence(reader,projectId,caseId) {
    const review=await read(reader,'review-cases',caseId);
    requireThat(review?.projectId===projectId && review.profile===PROFILE && review.chainId===1 &&
      review.input?.reviewProfile===PROFILE && review.state==='reviewed' && digest(review.input)===review.inputHash,'partner_review_incomplete');
    const v=context(review.input.partnerLaunch); requireThat(v.projectId===projectId,'partner_project_mismatch');
    await party(reader,v);
    const job=await read(reader,'review-jobs',review.reviewJobId);
    requireThat(job?.work==='completed' && job.billing==='settled' && job.inputHash===review.inputHash,'partner_review_not_settled');
    requireThat(review.sourceBinding?.inputHash===review.inputHash && review.sourceBinding.sourceHash===review.input.sourceHash &&
      review.sourceBinding.repository===review.input.repoUrl && review.sourceBinding.commit===review.input.baseCommit,'partner_source_unverified');
    const pub=await read(reader,'review-publications',caseId), project=await read(reader,'projects',projectId);
    const profile=await read(reader,'public-projects',project.slug), source=await read(reader,'public-sources',digest({projectId,id:review.input.sourceHash}));
    const publishedEvidence=await read(reader,'public-evidence',projectId);
    requireThat(pub?.published===true && profile?.published===true && profile.projectId===projectId && source?.published===true &&
      publishedEvidence?.reviews.some(r=>r.id===caseId && r.artifactHash===review.artifactHash),'partner_review_not_public');
    const request=await requestSource(reader,v,review.input.sourceHash);
    requireThat(v.components.includes(review.buildId),'partner_build_mismatch');
    for (const id of v.components) {
      const b=await read(reader,'builds',id);
      requireThat(b?.projectId===projectId && b.state==='compiled' && b.snapshotId===review.input.sourceHash &&
        review.input.contracts.includes(b.entry),'partner_component_not_reviewed');
      if(id===review.buildId)requireThat(b.artifactHash===review.input.buildHash,'partner_build_mismatch');
      const a=await artifacts.get(projectId,b.artifactHash,reader);validateCapitalBuild(a);
    }
    const report=await artifacts.get(projectId,review.artifactHash,reader);
    requireThat(report.complete===true && report.jobId===review.providerJobId && typeof report.report==='string' &&
      report.report.length>0,'partner_report_incomplete');
    const submissions=report.submissions;
    requireThat(submissions?.repoUrl===review.input.repoUrl && submissions.baseCommit===review.input.baseCommit &&
      Array.isArray(submissions.submissions),'partner_report_source');
    const judges=submissions.submissions.filter(s=>s.nodeKey==='audit_judge' && s.accepted===true), judge=judges[0];
    requireThat(judges.length===1 && judge.outcome==='completed' && judge.role==='review' && judge.safetyRefusal===false &&
      judge.verificationErrors===0 && judge.baseCommit===review.input.baseCommit && /^[a-f0-9]{64}$/.test(judge.hash??'') &&
      Array.isArray(judge.findings) && judge.findings.every(f=>['low','info','informational'].includes(f.severity)) &&
      submissions.submissions.every(s=>!s.accepted || s.baseCommit===review.input.baseCommit),'partner_blocking_review');
    requireThat(typeof judge.summary==='string' && judge.summary.split(/\r?\n/).filter(s=>s.trim()===endorsement(v)).length===1,
      'partner_explicit_endorsement_missing');
    return {context:v,launchWallet:request.launchWallet.toLowerCase(),findings:judge.findings,
      review:{caseId,providerJobId:review.providerJobId,artifactHash:review.artifactHash,reportHash:digest(report.report),
        sourceHash:review.input.sourceHash,buildHash:review.input.buildHash,judgeHash:judge.hash,inputHash:review.inputHash}};
  }
  return {
    async select(reader,projectId,{actor,chainId,partnerLaunchJson}) {
      const v=context(partnerLaunchJson); requireThat(chainId===1 && v.projectId===projectId,'partner_project_mismatch');
      const {project}=await party(reader,v),c=await identity.credential(actor,reader);
      requireThat(c.kind==='owner' && c.principalId===project.ownerId,'partner_owner_consent_required');
      return {chainId:1,profile:PROFILE};
    },
    async input({actor,projectId,build,partnerLaunchJson}) {
      const v=context(partnerLaunchJson); requireThat(v.projectId===projectId && v.components.includes(build.id),'partner_build_mismatch');
      const contracts=[];
      for(const id of v.components){const b=await builds.get(actor,projectId,id);
        requireThat(b.state==='compiled' && b.snapshotId===build.snapshotId,'partner_component_not_compiled');contracts.push(b.entry);}
      await requestSource(store,v,build.snapshotId);
      return {partnerLaunch:v,contracts:[...new Set(contracts)]};
    },
    async prepare(actor,projectId,caseId){
      await authority(actor,store);
      const review=await read(store,'review-cases',caseId);
      requireThat(review?.projectId===projectId && review.profile===PROFILE && review.chainId===1 &&
        review.input?.reviewProfile===PROFILE && digest(review.input)===review.inputHash &&
        !['failed','cancelled','blocked'].includes(review.state),'partner_review_incomplete');
      const v=context(review.input.partnerLaunch);requireThat(v.projectId===projectId,'partner_project_mismatch');
      const {project}=await party(store,v);
      const profile=await read(store,'public-projects',project.slug),source=await read(store,'public-sources',digest({projectId,id:review.input.sourceHash}));
      requireThat(profile?.published===true && profile.projectId===projectId && source?.published===true,'partner_review_not_public');
      requireThat(!await read(store,'partner-launch-cancellations',digest({projectId,contextHash:digest(v)})),'partner_context_revoked');
      await requestSource(store,v,review.input.sourceHash);
      return {context:v,caseId,inputHash:review.inputHash,sourceHash:review.input.sourceHash,buildHash:review.input.buildHash,
        approval:false,stage:'pending-independent-review'};
    },
    async inspect(actor,projectId,caseId){await authority(actor,store);return evidence(store,projectId,caseId);},
    async approve(actor,projectId,input){
      shape(input,['caseId','reportHash','reason','acknowledgedFindings','expiresAt']);contentHash(input.caseId);contentHash(input.reportHash);
      requireThat(typeof input.reason==='string' && input.reason.trim().length>=80 && input.reason.length<=4000 &&
        Array.isArray(input.acknowledgedFindings),'partner_decision_incomplete');
      return store.transaction(async tx=>{
        await authority(actor,tx);const e=await evidence(tx,projectId,input.caseId),v=e.context;
        requireThat(input.reportHash===e.review.reportHash && digest([...input.acknowledgedFindings].sort())===digest(e.findings.map(digest).sort()),'partner_decision_changed');
        const receiptId=digest({schemaVersion:'claus.partner-launch-admission.v1',projectId,caseId:input.caseId,contextHash:digest(v),expiresAt:input.expiresAt});
        requireThat(!await read(tx,'partner-launch-revocations',receiptId),'partner_admission_revoked');
        requireThat(!await read(tx,'partner-launch-cancellations',digest({projectId,contextHash:digest(v)})),'partner_context_revoked');
        const old=await read(tx,'partner-launch-receipts',receiptId);
        if(old){requireThat(old.reason===input.reason && old.expiresAt===input.expiresAt,'idempotency_conflict');return old;}
        requireThat(Number.isSafeInteger(input.expiresAt) && input.expiresAt>now() && input.expiresAt<=now()+3600000,'partner_decision_expiry');
        const receipt={schemaVersion:'claus.partner-launch-admission.v1',receiptId,decision:'approved',profileId:PROFILE_ID,
          partnerId:v.partnerId,assignmentHash:v.assignmentHash,requestHash:v.requestHash,projectId,ownerAddress:v.ownerAddress,
          creatorFeeRecipient:v.creatorFeeRecipient,launchWallet:e.launchWallet,chainId:1,kernelSourceHash:v.kernelSourceHash,
          policyOwner:v.policyOwner,policyExecutor:v.policyExecutor,review:e.review,approvedAt:now(),expiresAt:input.expiresAt,
          reason:input.reason,contextHash:digest(v)};
        await tx.write('partner-launch-receipts',receiptId,receipt,0);
        await tx.event({type:'partner_launch.approved',projectId,receiptId,requestHash:v.requestHash,at:now()});return receipt;
      });
    },
    async revoke(actor,projectId,receiptId){return store.transaction(async tx=>{
      const r=await read(tx,'partner-launch-receipts',receiptId);requireThat(r?.projectId===projectId,'not_found');
      const c=await identity.credential(actor,tx),p=await read(tx,'principals',c.principalId),project=await read(tx,'projects',projectId);
      requireThat(c.kind==='owner' && (p?.address?.toLowerCase()===CLAUS_IDENTITY && p.chainId===1 || project?.ownerId===c.principalId),'scope_denied');
      const prior=await read(tx,'partner-launch-revocations',receiptId);if(prior)return prior;
      const value={receiptId,revokedAt:now()};await tx.write('partner-launch-revocations',receiptId,value,0);
      const cancelled=digest({projectId,contextHash:r.contextHash});
      if(!await read(tx,'partner-launch-cancellations',cancelled))await tx.write('partner-launch-cancellations',cancelled,{projectId,contextHash:r.contextHash,revokedAt:now()},0);
      await tx.event({type:'partner_launch.revoked',projectId,receiptId,at:now()});return value;
    });},
    async publicReceipt(receiptId){contentHash(receiptId);return store.transaction(async tx=>{
      const r=await read(tx,'partner-launch-receipts',receiptId);requireThat(r && r.expiresAt>now(),'not_found');
      requireThat(!await read(tx,'partner-launch-revocations',receiptId),'partner_admission_revoked');
      requireThat(!await read(tx,'partner-launch-cancellations',digest({projectId:r.projectId,contextHash:r.contextHash})),'partner_context_revoked');
      const e=await evidence(tx,r.projectId,r.review.caseId);
      requireThat(digest(e.context)===r.contextHash && digest(e.review)===digest(r.review),'partner_admission_changed');return r;
    });}
  };
}
