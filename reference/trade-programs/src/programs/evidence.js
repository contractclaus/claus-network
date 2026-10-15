import {createHash} from 'node:crypto';
export const PROGRAM_PROFILE='claus-native-program-v1';
export const PROGRAM_OWNER='0x59edf6152080e847e5ea15f9ae6a77c1f03c44f5';
export const PROGRAM_REPOSITORY='https://github.com/contractclaus/claus-network-contracts';
export function canonical(v){
 if(v===null||typeof v==='boolean'||typeof v==='string')return JSON.stringify(v);
 if(typeof v==='number'&&Number.isSafeInteger(v)&&v>=0)return String(v);
 if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
 if(!v||Object.getPrototypeOf(v)!==Object.prototype)throw Error('program_invalid_evidence_json');
 return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
}
export const digest=v=>'sha256:'+createHash('sha256').update(canonical(v)).digest('hex');
const check=(ok,reason)=>{if(!ok)throw Error('program_'+reason);};
export function validRef(input){
 check(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).every(k=>['projectId','caseId'].includes(k)),'invalid_reference');
 check(/^prj_[A-Za-z0-9-]{1,100}$/.test(input.projectId??'')&&/^sha256:[a-f0-9]{64}$/.test(input.caseId??''),'invalid_reference');return input;
}
// All evidence is fetched from the fixed Network host with the existing identity.
// No caller-supplied artifact, report, address, calldata or signature is accepted.
export async function readProgramEvidence(network,input){
 const {projectId,caseId}=validRef(input);
 const [me,project,review]=await Promise.all([
  network.call('principal_me',{}),network.call('project_get',{projectId}),network.call('review_get',{projectId,caseId})
 ]);
 check(me.principal?.chainId===1&&me.principal.address?.toLowerCase()===PROGRAM_OWNER&&project.ownerId===me.principal.id&&!project.archivedAt,'owner_mismatch');
 check(review.id===caseId&&review.projectId===projectId&&review.profile===PROGRAM_PROFILE&&review.chainId===1&&review.state==='reviewed'&&review.job?.billing==='settled'&&review.publication?.published===true,'review_incomplete');
 check(review.input?.reviewProfile===PROGRAM_PROFILE&&review.input.chainId===1&&review.input.repoUrl===PROGRAM_REPOSITORY&&/^[a-f0-9]{40}$/.test(review.input.baseCommit??'')&&digest(review.input)===review.inputHash,'review_binding_invalid');
 const [build,artifact,report,snapshot,publicReport]=await Promise.all([
  network.call('build_get',{projectId,buildId:review.buildId}),network.call('build_artifact',{projectId,buildId:review.buildId}),
  network.call('review_artifact',{projectId,caseId}),network.call('snapshot_get',{projectId,snapshotId:review.input.sourceHash}),
  network.call('public_review',{caseId})
 ]);
 check(build.state==='compiled'&&build.snapshotId===review.input.sourceHash&&build.artifactHash===review.input.buildHash&&digest(artifact)===build.artifactHash,'artifact_binding_invalid');
 check(snapshot.publication?.published===true,'source_not_published');
 check(artifact.status==='compiled'&&['solidity-static-compile-v1','solidity-0.8.26-static-v1'].includes(artifact.profile?.profile)&&artifact.profile.evmVersion==='cancun'&&artifact.profile.viaIR===true&&artifact.profile.optimizerRuns===200,'compiler_invalid');
 check(Array.isArray(artifact.abi)&&artifact.abi.filter(x=>x.type==='constructor').every(x=>Array.isArray(x.inputs)&&x.inputs.length===0)&&/^0x(?:[a-f0-9]{2})+$/i.test(artifact.creationBytecode??'')&&artifact.creationBytecode.length<=98306,'artifact_invalid');
 check(report.complete===true&&report.jobId===review.providerJobId&&digest(report)===review.artifactHash&&typeof report.report==='string'&&report.report.length>0,'report_binding_invalid');
 check(publicReport?.caseId===caseId&&publicReport.projectId===projectId&&publicReport.artifactHash===review.artifactHash&&
  publicReport.providerJobId===review.providerJobId&&publicReport.reportHash===digest(report.report),'review_not_public');
 const submissions=report.submissions;
 check(submissions?.repoUrl===PROGRAM_REPOSITORY&&submissions.baseCommit===review.input.baseCommit&&Array.isArray(submissions.submissions),'report_source_invalid');
 const judges=submissions.submissions.filter(s=>s.nodeKey==='audit_judge'&&s.accepted===true);
 check(judges.length===1,'judge_missing');const judge=judges[0];
 check(judge.outcome==='completed'&&judge.role==='review'&&judge.safetyRefusal===false&&judge.verificationErrors===0&&judge.baseCommit===review.input.baseCommit&&/^[a-f0-9]{64}$/.test(judge.hash??'')&&Array.isArray(judge.findings),'judge_invalid');
 check(submissions.submissions.every(s=>!s.accepted||s.baseCommit===review.input.baseCommit),'review_source_invalid');
 check(judge.findings.every(f=>['low','info','informational'].includes(f.severity)&&typeof f.title==='string'&&typeof f.description==='string'),'blocking_or_unknown_findings');
 return {projectId,caseId,buildId:review.buildId,artifactHash:build.artifactHash,sourceHash:review.input.sourceHash,
  repository:PROGRAM_REPOSITORY,commit:review.input.baseCommit,reportArtifactHash:review.artifactHash,reportHash:digest(report.report),
  providerJobId:review.providerJobId,judgeHash:judge.hash,findings:judge.findings,artifact};
}
