import {PROFILE,PRINCIPAL,OWNER,context,check,caseRef} from './policy.mjs';
export async function selectCapitalReview({reader,identity,projectId,actor,chainId,capitalJson}){
 const value=context(capitalJson);
 check(chainId===(value.action==='launch'?1:8453),'review_chain');
 const credential=await identity.credential(actor,reader);
 const [principal,project]=await Promise.all([reader.read('principals',credential.principalId),reader.read('projects',projectId)]);
 check(credential.kind==='owner'&&principal?.value.chainId===1&&principal.value.address?.toLowerCase()===PRINCIPAL&&project?.value.ownerId===credential.principalId&&!project.value.archivedAt,'review_owner');
 await validateCapitalParty(reader,value,credential.principalId);
 return {chainId,profile:PROFILE};
}
export async function validateCapitalParty(reader,value,ownerId){
 const target=(await reader.read('projects',value.terms.projectId))?.value;
 check(target&&!target.archivedAt,'project_unavailable');
 const principal=(await reader.read('principals',target.ownerId))?.value;
 if(value.action==='launch')check(target.ownerId===ownerId&&value.terms.counterparty===OWNER,'launch_project_owner');
 else check(target.ownerId!==ownerId&&[1,8453].includes(principal?.chainId)&&principal.address?.toLowerCase()===value.terms.counterparty,'counterparty_owner');
}
export function validateCapitalBuild(artifact){
 check(artifact?.status==='compiled'&&['solidity-static-compile-v1','solidity-0.8.26-static-v1'].includes(artifact.profile?.profile)&&
  artifact.profile.evmVersion==='cancun'&&artifact.profile.viaIR===true&&artifact.profile.optimizerRuns===200&&
  /^0x(?:[0-9a-f]{2})+$/i.test(artifact.creationBytecode??'')&&Array.isArray(artifact.abi),'compiler');
}
export async function capitalReviewInput({capitalJson,build,builds,actor,projectId}){
 const capital=context(capitalJson),entries=[build.entry];
 if(capital.action==='launch')for(const component of capital.execution.components){
  const other=await builds.get(actor,projectId,component.buildId);
  check(other.state==='compiled'&&other.snapshotId===build.snapshotId,'component_source');
  entries.push(other.entry);
 }
 const contracts=[...new Set(entries)];
 check(contracts.length<=4,'review_entries');
 return {capital,contracts};
}
