import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/storage/index.mjs';
import {createArtifactStore} from '../src/artifact-store/index.mjs';
import {createRuntimeReleases,RUNTIME_IMAGE_PROFILE,runtimeEndorsement,OWNER_SEARCH_PROJECT,OWNER_RUNTIME_REVIEW_PROFILE} from '../src/infrastructure/runtime-release.mjs';
import {CLAUS_IDENTITY} from '../src/partner-launch/policy.mjs';
import {digest,requireThat} from '../src/shared/index.mjs';
import {reviewRequest} from '../adapters/imd.mjs';
import {verifyPublicSource} from '../adapters/public-source.mjs';
import {createReviewFlow} from '../src/review-flow/index.mjs';
import {ROUTES} from '../interfaces/contract.mjs';

async function fixture(t,owned=false){
 const store=openStore(':memory:');t.after(()=>store.close());const artifacts=createArtifactStore({store}),projectId=owned?OWNER_SEARCH_PROJECT:'prj_external',buildId=digest('build'),snapshotId=digest('snapshot'),caseId=digest('case'),planId=digest('plan'),sourceHash=digest('source'),imageDigest=digest('image'),archiveHash=digest('archive');
 const identity={credential:async actor=>({kind:'owner',principalId:actor}),authorize:async(a,_p,s)=>requireThat(a==='builder'&&s.projectId===projectId,'scope_denied'),allowed:async()=>true};
 const service=createRuntimeReleases({store,identity,artifacts,origin:'https://api.example.com'});
 let artifactHash;
 await store.transaction(async tx=>{
  await tx.write('principals','claus',{chainId:1,address:CLAUS_IDENTITY},0);await tx.write('principals','builder',{chainId:1,address:'0x'+'1'.repeat(40)},0);
  await tx.write('projects',projectId,{ownerId:owned?'claus':'builder'},0);
  artifactHash=await artifacts.put(tx,projectId,{evidence:'compiled_only',buildId,projectId,planId,sourceHash,imageDigest,archiveHash,storage:{state:'verified'}});
  await tx.write('oci-builds',buildId,{id:buildId,actor:'builder',projectId,planId,sourceHash,snapshotId,dockerfile:'Dockerfile',state:'compiled',publishSource:true,registry:{enabled:true,imageDigest,archiveHash},artifactHash},0);
  await tx.write('workflow-jobs',buildId,{state:'complete'},0);await tx.write('public-sources',digest({projectId,id:snapshotId}),{published:true},0);
 });
 const manifest={version:1,mode:owned?'model':'http',image:`api.example.com/claus/${buildId.slice(7)}@${imageDigest}`,region:'ams',cpu:1,memoryMiB:256,gpu:null,port:8080,healthPath:'/health',command:owned?[]:['node','server.mjs'],storageGiB:0};
 const release=await service.prepare('builder',projectId,{buildId,manifest}),ctx=(await service.input('builder',projectId,release.id,buildId)).runtimeImage;
 const input={repoUrl:'https://github.com/example/project',baseCommit:'a'.repeat(40),contracts:[],sourceHash:snapshotId,buildHash:artifactHash,reviewProfile:RUNTIME_IMAGE_PROFILE,runtimeImage:ctx};
 let report={jobId:'imd-original',complete:true,report:'Independent runtime audit',submissions:{repoUrl:input.repoUrl,baseCommit:input.baseCommit,submissions:[{nodeKey:'audit_judge',accepted:true,outcome:'completed',role:'review',safetyRefusal:false,verificationErrors:0,baseCommit:input.baseCommit,hash:'b'.repeat(64),findings:[],summary:runtimeEndorsement(ctx)}]}};
 await store.transaction(async tx=>{const hash=await artifacts.put(tx,projectId,report);await tx.write('review-cases',caseId,{id:caseId,projectId,profile:RUNTIME_IMAGE_PROFILE,state:'reviewed',input,inputHash:digest(input),reviewJobId:'paid-original',providerJobId:report.jobId,artifactHash:hash,sourceBinding:{inputHash:digest(input),sourceHash:snapshotId,repository:input.repoUrl,commit:input.baseCommit}},0);await tx.write('review-jobs','paid-original',{work:'completed',billing:'settled',inputHash:digest(input)},0);await tx.write('review-publications',caseId,{published:true},0);});
 const decision={caseId,reportHash:digest(report.report),reason:'The exact runtime and review are suitable for this application.',acknowledgedFindings:[],expectedRevision:1};
 const update=(collection,id,patch)=>store.transaction(async tx=>{const r=await tx.read(collection,id);await tx.write(collection,id,{...r.value,...patch},r.revision);});
 return {service,store,artifacts,identity,projectId,buildId,snapshotId,caseId,release,manifest,ctx,input,report,decision,update};
}
test('runtime admission requires the exact verified build, settled review and Claus decision',async t=>{
 const f=await fixture(t);assert.equal((await f.service.status(f.release.id)).approved,false);
 await assert.rejects(f.service.approve('builder',f.projectId,f.release.id,f.decision),/claus_required/);
 await f.update('review-jobs','paid-original',{billing:'pending'});await assert.rejects(f.service.approve('claus',f.projectId,f.release.id,f.decision),/review_incomplete/);
 await f.update('review-jobs','paid-original',{billing:'settled'});const approved=await f.service.approve('claus',f.projectId,f.release.id,f.decision);assert.equal(approved.approved,true);assert.equal((await f.service.status(f.release.id)).approved,true);
 await assert.rejects(f.service.prepare('builder',f.projectId,{buildId:f.buildId,manifest:{...f.manifest,image:'evil.example/x@'+digest('x')}}),/changed/);
 await f.service.revoke('builder',f.projectId,f.release.id,{expectedRevision:approved.revision});assert.equal((await f.service.status(f.release.id)).approved,false);
 await assert.rejects(f.service.approve('claus',f.projectId,f.release.id,f.decision),/revision_conflict/);
});
test('withdrawn source, changed owner or withdrawn review invalidates a saved approval',async t=>{
 for(const kind of ['source','owner','review']){const f=await fixture(t);await f.service.approve('claus',f.projectId,f.release.id,f.decision);
 if(kind==='source')await f.update('public-sources',digest({projectId:f.projectId,id:f.snapshotId}),{published:false});
 if(kind==='owner')await f.update('projects',f.projectId,{ownerId:'other'});
 if(kind==='review')await f.update('review-publications',f.caseId,{published:false});
 assert.equal((await f.service.status(f.release.id)).approved,false);}
});
test('generic clean reports and unresolved material findings do not approve a runtime',async t=>{
 for(const kind of ['marker','finding','context']){const f=await fixture(t),report=structuredClone(f.report);if(kind==='marker')report.submissions.submissions[0].summary='Looks fine';if(kind==='finding')report.submissions.submissions[0].findings=[{severity:'high',title:'escape'}];
 const hash=await f.store.transaction(tx=>f.artifacts.put(tx,f.projectId,report));await f.update('review-cases',f.caseId,{artifactHash:hash,...(kind==='context'?{input:{...f.input,runtimeImage:{...f.ctx,manifest:{...f.ctx.manifest,command:['other']}}}}:{})});
 await assert.rejects(f.service.approve('claus',f.projectId,f.release.id,f.decision),/runtime_image_/);}
});
test('runtime audit uses supported generic job input and compares non-Solidity source exactly',async t=>{
 const f=await fixture(t),request=reviewRequest(f.input);assert.equal(request.action,'job.open');assert.equal(request.input.template,'audit');assert(!Object.hasOwn(request.input,'contracts'));assert(request.input.objective.includes(runtimeEndorsement(f.ctx)));assert(request.input.objective.includes(f.ctx.manifest.image));
 const raw=[{path:'Dockerfile',content:'FROM scratch\n'},{path:'server.mjs',content:'export const version=1;'}],files=raw.map(x=>({...x,hash:digest(x)})),sourceHash=digest(files.map(({path,hash})=>({path,hash})));
 const result=await verifyPublicSource({input:{...f.input,sourceHash},files,fetch:async url=>new Response(raw.find(x=>url.endsWith('/'+x.path)).content)});assert.equal(result.sourceHash,sourceHash);
 await assert.rejects(verifyPublicSource({input:{...f.input,sourceHash},files,fetch:async()=>new Response('changed')}),/source_mismatch/);
 const prep=ROUTES.find(x=>x.name==='resource_release_prepare');assert(!prep.inputSchema.properties.manifest.required.includes('releaseHash'));
});

test('the existing review queue accepts exact OCI context and reuses its original paid case',async t=>{
 const f=await fixture(t);await f.store.transaction(tx=>tx.write('review-pilots',f.projectId,{enabled:true,expiresAt:Date.now()+60000,maximumPerReview:'500000000000000000'},0));let enqueues=0;
 const flow=createReviewFlow({store:f.store,identity:f.identity,artifacts:f.artifacts,runtimeReleases:f.service,builds:{get:async()=>{throw Error('not a Solidity build');}},jobs:{enqueue:async()=>{enqueues++;return{id:'quote-work'};}},selectReviewProfile:(reader,projectId,input)=>f.service.select(reader,projectId,input),validatePublicBuild:async()=>true});
 const input={buildId:f.buildId,repoUrl:f.input.repoUrl,baseCommit:f.input.baseCommit,idempotencyKey:'original',profile:RUNTIME_IMAGE_PROFILE,runtimeReleaseId:f.release.id};
 const existing=await flow.request('builder',f.projectId,input);assert.equal(existing.id,f.caseId);assert.equal(enqueues,0);
 await f.update('review-cases',f.caseId,{inputHash:digest('other')});
 const created=await flow.request('builder',f.projectId,input);assert.equal(enqueues,1);assert.deepEqual(created.input.runtimeImage,f.ctx);assert(!Object.hasOwn(created.input,'chainId'));
 const same=await flow.request('builder',f.projectId,input);assert.equal(same.id,created.id);assert.equal(enqueues,1);
});

test('review host resolves public R2 snapshots without storage credentials',async()=>{
 const {loadReviewSource}=await import('../runtime/review-public-source.mjs');
 const files=[{path:'Dockerfile',content:'FROM scratch\n# 🐙'}];files[0].hash=digest(files[0]);
 const snapshotId=digest(files.map(({path,hash})=>({path,hash}))),projectId='project';
 const request=async(url,options)=>{assert.equal(url,'https://claus-network-api.vercel.app/v1/public/sources/'+encodeURIComponent(digest({projectId,id:snapshotId})));assert.equal(options.redirect,'error');return Response.json({projectId,snapshotId,files});};
 assert.deepEqual(await loadReviewSource(projectId,snapshotId,{request}),files);
 await assert.rejects(loadReviewSource('other',snapshotId,{request:async()=>Response.json({projectId,snapshotId,files})}),e=>e.code==='source_mismatch');
 await assert.rejects(loadReviewSource(projectId,snapshotId,{request:async()=>new Response('',{status:404})}),e=>e.code==='source_unavailable');
});


test('inspection supplies exact finding hashes without weakening the approval decision',async t=>{
 const f=await fixture(t),report=structuredClone(f.report);report.submissions.submissions[0].findings=[{severity:'low',title:'Optional cleanup'}];
 const hash=await f.store.transaction(tx=>f.artifacts.put(tx,f.projectId,report));await f.update('review-cases',f.caseId,{artifactHash:hash});
 const inspected=await f.service.inspect('claus',f.projectId,f.release.id,f.caseId);assert.deepEqual(inspected.findingHashes,inspected.findings.map(digest));
 await assert.rejects(f.service.approve('claus',f.projectId,f.release.id,f.decision),/decision_invalid/);
 const approved=await f.service.approve('claus',f.projectId,f.release.id,{...f.decision,acknowledgedFindings:inspected.findingHashes});assert.equal(approved.approved,true);
});

test('runtime approval accepts its documented reason length and rejects malformed text',async t=>{
 const f=await fixture(t),reason=('Considered the exact review findings.\n').repeat(110).slice(0,4000);
 assert.equal(reason.length,4000);
 const approved=await f.service.approve('claus',f.projectId,f.release.id,{...f.decision,reason});
 assert.equal(approved.approved,true);assert.equal(approved.decision.reason,reason);
 await assert.rejects(f.service.approve('claus',f.projectId,f.release.id,{...f.decision,reason:reason+'x'}),/invalid_text/);
 await assert.rejects(f.service.approve('claus',f.projectId,f.release.id,{...f.decision,reason:'A full review reason with a hidden\u0000control'}),/invalid_text/);
});

const ownerReport={report:'Operator review of the exact Search image. '+('Reviewed signed admission, bounded model execution, source digests and client retry behavior. ').repeat(3),findingsJson:JSON.stringify([{severity:'info',title:'Finite capacity',description:'The single CPU service has finite capacity and can return retryable rejections.'}]),published:true};
const ownerDecision=(r,extra={})=>({reviewId:r.id,reportHash:r.reportHash,acknowledgedFindings:r.findings.map(digest),expectedRevision:1,reason:'I read this operator report and approve the exact bounded Search image under the owner policy.',...extra});
test('owner Search review is explicit, public, idempotent and still requires a separate Claus decision',async t=>{
 const f=await fixture(t,true);await f.update('review-jobs','paid-original',{billing:'pending'});
 await assert.rejects(f.service.ownerReview('builder',f.projectId,f.release.id,ownerReport),/claus_required/);
 const r=await f.service.ownerReview('claus',f.projectId,f.release.id,ownerReport);
 assert.equal((await f.service.ownerReview('claus',f.projectId,f.release.id,ownerReport)).id,r.id);
 const published=await f.service.publicOwnerReview(r.id);assert.equal(published.independent,false);assert.equal(published.authorship,'owner_operator');assert.equal(published.report,ownerReport.report);
 assert.equal((await f.service.status(f.release.id)).approved,false);
 await assert.rejects(f.service.ownerApprove('builder',f.projectId,f.release.id,ownerDecision(r)),/claus_required/);
 await assert.rejects(f.service.ownerApprove('claus',f.projectId,f.release.id,ownerDecision(r,{acknowledgedFindings:[]})),/decision_invalid/);
 await assert.rejects(f.service.ownerApprove('claus',f.projectId,f.release.id,ownerDecision(r,{reportHash:digest('wrong')})),/decision_invalid/);
 const approved=await f.service.ownerApprove('claus',f.projectId,f.release.id,ownerDecision(r));
 const status=await f.service.status(f.release.id);assert.equal(status.approved,true);assert.equal(status.reviewType,OWNER_RUNTIME_REVIEW_PROFILE);
 assert.equal((await f.store.read('review-jobs','paid-original')).value.billing,'pending');
 await f.service.revoke('builder',f.projectId,f.release.id,{expectedRevision:approved.revision});assert.equal((await f.service.status(f.release.id)).approved,false);
});
test('owner review cannot admit foreign projects or expand the bounded Search resource profile',async t=>{
 const external=await fixture(t);await assert.rejects(external.service.ownerReview('claus',external.projectId,external.release.id,ownerReport),/owner_scope_denied/);
 const f=await fixture(t,true);
 for(const change of [{cpu:3},{memoryMiB:8192},{gpu:'GPU'},{command:['other']},{port:8081},{mode:'http'}]){
  const next=await f.service.prepare('builder',f.projectId,{buildId:f.buildId,manifest:{...f.manifest,...change}});
  await assert.rejects(f.service.ownerReview('claus',f.projectId,next.id,ownerReport),/owner_scope_denied/);
 }
 await f.update('projects',f.projectId,{ownerId:'builder'});
 await assert.rejects(f.service.ownerReview('claus',f.projectId,f.release.id,ownerReport),/runtime_image_/);
});
test('owner reports remain bound to the exact manifest, owner and published source',async t=>{
 for(const invalidation of ['source','owner']){
  const f=await fixture(t,true),r=await f.service.ownerReview('claus',f.projectId,f.release.id,ownerReport);
  const other=await f.service.prepare('builder',f.projectId,{buildId:f.buildId,manifest:{...f.manifest,region:'other'}});
  await assert.rejects(f.service.ownerApprove('claus',f.projectId,other.id,ownerDecision(r)),/owner_review_incomplete/);
  await f.service.ownerApprove('claus',f.projectId,f.release.id,ownerDecision(r));
  if(invalidation==='source')await f.update('public-sources',digest({projectId:f.projectId,id:f.snapshotId}),{published:false});
  else await f.update('projects',f.projectId,{ownerId:'builder'});
  assert.equal((await f.service.status(f.release.id)).approved,false);
 }
});
test('owner policy retains unresolved material findings and blocks approval',async t=>{
 const f=await fixture(t,true),r=await f.service.ownerReview('claus',f.projectId,f.release.id,{...ownerReport,findingsJson:JSON.stringify([{severity:'medium',title:'Unresolved',description:'Requires a source correction before deployment.'}])});
 assert.equal((await f.service.publicOwnerReview(r.id)).findings[0].severity,'medium');
 await assert.rejects(f.service.ownerInspect('claus',f.projectId,f.release.id,r.id),/blocking_review/);
 await assert.rejects(f.service.ownerApprove('claus',f.projectId,f.release.id,ownerDecision(r)),/blocking_review/);
 assert.equal((await f.service.status(f.release.id)).approved,false);
});
