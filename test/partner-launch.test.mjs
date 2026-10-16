import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/storage/index.mjs';
import {createArtifactStore} from '../src/artifact-store/index.mjs';
import {createPartnerLaunches} from '../src/partner-launch/index.mjs';
import {PROFILE,PROFILE_ID,CLAUS_IDENTITY,QUOTE,context,endorsement,requestHash} from '../src/partner-launch/policy.mjs';
import {digest} from '../src/shared/index.mjs';
import {reviewRequest} from '../adapters/imd.mjs';
import {createApplication} from '../runtime/server.mjs';

const addr=n=>'0x'+n.repeat(40),now=1792178400000;
async function fixture(t){
 const store=openStore(':memory:');t.after(()=>store.close());const artifacts=createArtifactStore({store});
 const pins={schemaVersion:'programmable.claus-partner-assignment.v1',partnerId:'11111111-1111-4111-8111-111111111111',mode:'enabled',activeAfter:'2026-10-16T00:00:00.000Z',kernelSourceHash:digest('kernel'),policyOwner:addr('2'),policyExecutor:addr('3')};
 const projectId='prj_external',caseId=digest('case'),buildId=digest('build'),snapshotId=digest('snapshot');
 const request={schemaVersion:'programmable.custom-launch-create-request.v3',chainId:'1',launchWallet:addr('4'),launchProfileSelection:{poolKey:{currency0:QUOTE,currency1:addr('5'),fee:0,tickSpacing:60}},ticks:[-60,60]};
 const ctx={schemaVersion:'claus.partner-launch-review.v1',profileId:PROFILE_ID,partnerId:pins.partnerId,assignmentHash:digest(pins),projectId,ownerAddress:addr('4'),creatorFeeRecipient:addr('4'),requestHash:requestHash(request),requestFile:'launch/request.json',kernelSourceHash:pins.kernelSourceHash,policyOwner:pins.policyOwner,policyExecutor:pins.policyExecutor,independence:'Independent creator controls this external project and supplies public ownership evidence. This is not a Claus-owned project or an additional token for Claus.',components:[buildId]};
 const source={path:ctx.requestFile,content:JSON.stringify(request)},fileHash=digest(source),commit='a'.repeat(40),repoUrl='https://github.com/example/independent-project';
 let input,report,review,reportHash;
 await store.transaction(async tx=>{
  for(const [id,address] of [['external',addr('4')],['claus',CLAUS_IDENTITY],['other',addr('9')]])await tx.write('principals',id,{id,address,chainId:1},0);
  await tx.write('projects',projectId,{id:projectId,ownerId:'external',slug:'independent-project'},0);
  await tx.write('public-projects','independent-project',{projectId,published:true},0);
  await tx.write('snapshots',digest({projectId,id:snapshotId}),{projectId,id:snapshotId,files:[{path:source.path,hash:fileHash}]},0);
  await tx.write('artifacts',digest({projectId,id:fileHash}),{projectId,...source,hash:fileHash},0);
  await tx.write('public-sources',digest({projectId,id:snapshotId}),{published:true},0);
  const buildHash=await artifacts.put(tx,projectId,{status:'compiled',profile:{profile:'solidity-0.8.26-static-v1',evmVersion:'cancun',viaIR:true,optimizerRuns:200},creationBytecode:'0x6000',abi:[]});
  await tx.write('builds',buildId,{id:buildId,projectId,state:'compiled',snapshotId,artifactHash:buildHash,entry:'contracts/Hook.sol'},0);
  input={repoUrl,baseCommit:commit,contracts:['contracts/Hook.sol'],sourceHash:snapshotId,buildHash,reviewProfile:PROFILE,chainId:1,partnerLaunch:ctx};
  report={complete:true,jobId:'imd-original',report:'Independent review',submissions:{repoUrl,baseCommit:commit,submissions:[{nodeKey:'audit_judge',accepted:true,outcome:'completed',role:'review',safetyRefusal:false,verificationErrors:0,baseCommit:commit,hash:'b'.repeat(64),findings:[],summary:endorsement(ctx)}]}};
  const artifactHash=await artifacts.put(tx,projectId,report);reportHash=digest(report.report);
  review={id:caseId,projectId,buildId,profile:PROFILE,chainId:1,state:'reviewed',input,inputHash:digest(input),reviewJobId:'paid-original',providerJobId:report.jobId,artifactHash,sourceBinding:{inputHash:digest(input),sourceHash:snapshotId,repository:repoUrl,commit}};
  await tx.write('review-cases',caseId,review,0);
  await tx.write('review-jobs','paid-original',{work:'completed',billing:'settled',inputHash:digest(input)},0);
  await tx.write('review-publications',caseId,{published:true},0);
  await tx.write('public-evidence',projectId,{reviews:[{id:caseId,artifactHash}]},0);
 });
 const identity={credential:async a=>({kind:'owner',principalId:a})};
 const service=createPartnerLaunches({store,identity,artifacts,pins,now:()=>now});
 const decision={caseId,reportHash,reason:'I verified the independent creator and the exact reviewed request, and approve this project launch with the pinned safety kernel and fee recipients.',acknowledgedFindings:[],expiresAt:now+600000};
 const update=(collection,id,patch)=>store.transaction(async tx=>{const r=await tx.read(collection,id);return tx.write(collection,id,{...r.value,...patch},r.revision);});
 return {store,artifacts,service,pins,projectId,caseId,ctx,input,report,review,decision,update};
}
test('Claus approval is exact, idempotent and readable; another actor cannot approve',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.service.approve('external',f.projectId,f.decision),/claus_decision_required/);
 const r=await f.service.approve('claus',f.projectId,f.decision);
 assert.deepEqual(await f.service.approve('claus',f.projectId,f.decision),r);
 assert.deepEqual(await f.service.publicReceipt(r.receiptId),r);
 await assert.rejects(f.service.approve('claus',f.projectId,{...f.decision,reason:f.decision.reason+' changed'}),/idempotency_conflict/);
 assert.equal(r.requestHash,f.ctx.requestHash);assert.equal(r.ownerAddress,addr('4'));
});
test('real project owner may revoke and stored approval cannot silently revive',async t=>{
 const f=await fixture(t),r=await f.service.approve('claus',f.projectId,f.decision);
 await assert.rejects(f.service.revoke('other',f.projectId,r.receiptId),/scope_denied/);
 await f.service.revoke('external',f.projectId,r.receiptId);
 await assert.rejects(f.service.publicReceipt(r.receiptId),/revoked/);
});
test('Claus can renew a short approval without another paid review, but cannot bypass owner revocation',async t=>{
 const f=await fixture(t),first=await f.service.approve('claus',f.projectId,f.decision);
 const renewal={...f.decision,expiresAt:f.decision.expiresAt+600000};
 const second=await f.service.approve('claus',f.projectId,renewal);
 assert.notEqual(second.receiptId,first.receiptId);
 assert.deepEqual(second.review,first.review);
 await f.service.revoke('external',f.projectId,first.receiptId);
 await assert.rejects(f.service.publicReceipt(second.receiptId),/context_revoked/);
 await assert.rejects(f.service.approve('claus',f.projectId,{...renewal,expiresAt:renewal.expiresAt+600000}),/context_revoked/);
});
test('pending provider preparation uses the original case without claiming an IMD approval',async t=>{
 const f=await fixture(t);await f.update('review-cases',f.caseId,{state:'preparing',artifactHash:null});
 await assert.rejects(f.service.prepare('external',f.projectId,f.caseId),/claus_decision_required/);
 const prepared=await f.service.prepare('claus',f.projectId,f.caseId);
 assert.equal(prepared.approval,false);assert.equal(prepared.stage,'pending-independent-review');
 assert.equal(prepared.context.requestHash,f.ctx.requestHash);
 await assert.rejects(f.service.approve('claus',f.projectId,f.decision),/review_incomplete/);
 await f.update('projects',f.projectId,{ownerId:'other'});
 await assert.rejects(f.service.prepare('claus',f.projectId,f.caseId),/owner_changed/);
});
test('ownership changes and withdrawn review/source invalidate public admission',async t=>{
 for(const kind of ['owner','review','source','suspended']){
  const f=await fixture(t),r=await f.service.approve('claus',f.projectId,f.decision);
  if(kind==='owner')await f.update('projects',f.projectId,{ownerId:'other'});
  if(kind==='review')await f.update('review-publications',f.caseId,{published:false});
  if(kind==='source')await f.update('public-sources',digest({projectId:f.projectId,id:f.input.sourceHash}),{published:false});
  if(kind==='suspended')await f.store.transaction(tx=>tx.write('project-access',f.projectId,{suspended:true},0));
  await assert.rejects(f.service.publicReceipt(r.receiptId),/partner_/);
 }
});
test('incomplete settlement and source mismatch cannot become approval',async t=>{
 const f=await fixture(t);await f.update('review-jobs','paid-original',{billing:'reserved'});
 await assert.rejects(f.service.approve('claus',f.projectId,f.decision),/not_settled/);
 await f.update('review-jobs','paid-original',{billing:'settled'});await f.update('review-cases',f.caseId,{sourceBinding:{}});
 await assert.rejects(f.service.approve('claus',f.projectId,f.decision),/source_unverified/);
});
test('blocking findings or a missing exact endorsement reject an otherwise complete review',async t=>{
 for(const kind of ['finding','marker']){
  const f=await fixture(t),report=structuredClone(f.report);
  if(kind==='finding')report.submissions.submissions[0].findings=[{severity:'medium',title:'Authority bypass',description:'Reproduction'}];
  else report.submissions.submissions[0].summary='Looks good';
  const artifactHash=await f.store.transaction(tx=>f.artifacts.put(tx,f.projectId,report));
  await f.update('review-cases',f.caseId,{artifactHash});await f.update('public-evidence',f.projectId,{reviews:[{id:f.caseId,artifactHash}]});
  await assert.rejects(f.service.approve('claus',f.projectId,f.decision),/blocking_review|endorsement_missing/);
 }
});
test('protected assignment, no-self-token rule and immutable request hashing remain mandatory',async t=>{
 const f=await fixture(t);
 assert.throws(()=>context({...f.ctx,ownerAddress:CLAUS_IDENTITY,creatorFeeRecipient:CLAUS_IDENTITY}),/self_token/);
 const disabled=createPartnerLaunches({store:f.store,identity:{credential:async()=>({kind:'owner',principalId:'claus'})},artifacts:f.artifacts,now:()=>now});
 await assert.rejects(disabled.approve('claus',f.projectId,f.decision),/not_enabled/);
 const bad={...f.input,partnerLaunch:{...f.ctx,requestHash:digest('changed')}};
 await f.update('review-cases',f.caseId,{input:bad,inputHash:digest(bad)});
 await assert.rejects(f.service.approve('claus',f.projectId,f.decision),/not_settled|source_unverified|request_mismatch/);
});
test('IMD receives independent ownership, exact request path and protected fee requirements',async t=>{
 const f=await fixture(t),r=reviewRequest(f.input);
 assert(r.input.objective.includes(endorsement(f.ctx)));
 assert(r.input.objective.includes(f.ctx.requestFile));
 assert(r.input.objective.includes('different wallet alone is not sufficient'));
 assert(r.input.objective.includes('1500bps'));
});
test('HTTP/MCP route exists but no unconfigured approval or anonymous writes are exposed',async t=>{
 const store=openStore(':memory:');t.after(()=>store.close());const app=createApplication({store,rateSalt:'test-only'.repeat(8)});
 const response=await app.fetch(new Request('https://claus.si/v1/public/partner-launches/'+encodeURIComponent(digest('missing'))));
 assert.equal(response.status,404);
 const routes=app.service.routes;
 assert(routes.some(r=>r.name==='partner_launch_approve'&&!r.public));
 assert(routes.find(r=>r.name==='review_create').inputSchema.properties.profile.enum.includes(PROFILE));
});
