import {PROFILE,PRINCIPAL,check,context,caseRef,digest,endorsement} from './policy.mjs';
const REPOSITORY='https://github.com/contractclaus/claus-network-contracts';
export async function capitalEvidence(network,reference){
 const {projectId,caseId}=caseRef(reference);
 const [me,project,review]=await Promise.all([network.call('principal_me',{}),network.call('project_get',{projectId}),network.call('review_get',{projectId,caseId})]);
 check(me.principal?.chainId===1&&me.principal.address?.toLowerCase()===PRINCIPAL&&project.ownerId===me.principal.id&&!project.archivedAt,'review_owner');
 check(review.id===caseId&&review.projectId===projectId&&review.profile===PROFILE&&review.input?.reviewProfile===PROFILE&&review.state==='reviewed'&&review.job?.billing==='settled'&&review.publication?.published===true,'review_incomplete');
 check(review.input.repoUrl===REPOSITORY&&/^[a-f0-9]{40}$/.test(review.input.baseCommit)&&digest(review.input)===review.inputHash,'review_binding');
 const capital=context(review.input.capital);
 check(review.chainId===(capital.action==='launch'?1:8453),'review_chain');
 const [build,artifact,report,snapshot,publicReport]=await Promise.all([
  network.call('build_get',{projectId,buildId:review.buildId}),network.call('build_artifact',{projectId,buildId:review.buildId}),
  network.call('review_artifact',{projectId,caseId}),network.call('snapshot_get',{projectId,snapshotId:review.input.sourceHash}),network.call('public_review',{caseId})]);
 check(build.state==='compiled'&&build.snapshotId===review.input.sourceHash&&build.artifactHash===review.input.buildHash&&digest(artifact)===build.artifactHash&&snapshot.publication?.published===true,'artifact_binding');
 check(report.complete===true&&report.jobId===review.providerJobId&&digest(report)===review.artifactHash&&typeof report.report==='string'&&report.report.length>0,'report_binding');
 check(publicReport.caseId===caseId&&publicReport.projectId===projectId&&publicReport.artifactHash===review.artifactHash&&publicReport.providerJobId===review.providerJobId&&publicReport.reportHash===digest(report.report),'review_not_public');
 const submissions=report.submissions;
 check(submissions?.repoUrl===REPOSITORY&&submissions.baseCommit===review.input.baseCommit&&Array.isArray(submissions.submissions),'report_source');
 const judges=submissions.submissions.filter(s=>s.nodeKey==='audit_judge'&&s.accepted===true);
 check(judges.length===1,'judge_missing');const judge=judges[0];
 check(judge.outcome==='completed'&&judge.role==='review'&&judge.safetyRefusal===false&&judge.verificationErrors===0&&judge.baseCommit===review.input.baseCommit&&/^[a-f0-9]{64}$/.test(judge.hash??'')&&Array.isArray(judge.findings),'judge_invalid');
 check(submissions.submissions.every(s=>!s.accepted||s.baseCommit===review.input.baseCommit),'source_changed');
 check(judge.findings.every(f=>['low','info','informational'].includes(f.severity)&&typeof f.title==='string'&&typeof f.description==='string'),'blocking_findings');
 check(typeof judge.summary==='string'&&judge.summary.split(/\r?\n/).filter(s=>s.trim()===endorsement(capital)).length===1,'explicit_capital_endorsement_missing');
 const artifacts={};
 if(capital.action==='launch')for(const component of capital.execution.components){
  const [b,a]=await Promise.all([network.call('build_get',{projectId,buildId:component.buildId}),network.call('build_artifact',{projectId,buildId:component.buildId})]);
  check(b.state==='compiled'&&b.snapshotId===build.snapshotId&&digest(a)===b.artifactHash&&review.input.contracts.includes(b.entry),'component_review_binding');
  artifacts[component.buildId]=a;
 }
 return {reference,capital,artifact,artifacts,sourceHash:build.snapshotId,commit:review.input.baseCommit,
  reportHash:digest(report.report),reportArtifactHash:review.artifactHash,judgeHash:judge.hash,findings:judge.findings};
}
export function capitalDecision(input,proof){
 check(input&&Object.keys(input).sort().join(',')==='acknowledgedFindings,reason,reference,reportHash','decision_fields');
 caseRef(input.reference);
 check(input.reportHash===proof.reportHash&&typeof input.reason==='string'&&input.reason.trim().length>=40&&input.reason.length<=4000&&Array.isArray(input.acknowledgedFindings)&&digest([...input.acknowledgedFindings].sort())===digest(proof.findings.map(digest).sort()),'decision_incomplete');
}
