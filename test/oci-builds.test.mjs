import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/storage/index.mjs';
import {createArtifactStore} from '../src/artifact-store/index.mjs';
import {createJobs} from '../src/jobs/index.mjs';
import {createOciBuilds} from '../src/infrastructure/builds.mjs';
import {createOciBuildPlan} from '../src/infrastructure/build-plan.mjs';
import {digest} from '../src/shared/index.mjs';
import {ROUTES,validate} from '../interfaces/contract.mjs';

export async function fixture(t,{lost=false,enabled=true}={}){
 const store=openStore(':memory:');t.after(()=>store.close());let at=1000000,allowed=true,published=true,calls=0,inspection=0,seen;
 const identity={authorize:async a=>{assert.equal(a,'owner');},allowed:async()=>allowed};
 const files=[{path:'Dockerfile',content:'FROM scratch\nCOPY index.html /index.html\n'},{path:'index.html',content:'hi'}];
 const projects={publicSource:async()=>{if(!published)throw Object.assign(Error('not_found'),{code:'not_found'});return {projectId:'p',snapshotId:'s',files};}};
 const jobs=createJobs({store,identity,now:()=>at});const artifacts=createArtifactStore({store});
 const ports={dispatch:async v=>{calls++;seen=v;if(lost)throw Error('response lost');return {buildId:v.id,state:'running'};},inspect:async v=>{inspection++;return {buildId:v.id,state:'compiled',runUrl:'https://github.com/contractclaus/claus-network/actions/runs/1',receipt:{buildId:v.id,projectId:v.projectId,planId:v.planId,sourceHash:v.sourceHash,imageDigest:digest('image'),archiveHash:digest('archive'),archiveBytes:200,evidence:'compiled_only'}};},verify:async()=>true};
 const api=createOciBuilds({store,identity,projects,jobs,artifacts,ports,enabled,now:()=>at});
 return {api,store,jobs,ports,projects,input:{snapshotId:'s',publishSource:true,idempotencyKey:'same'},advance:()=>at+=61000,revoke:()=>allowed=false,withdraw:()=>published=false,calls:()=>calls,inspections:()=>inspection};
}
test('lost dispatch reconciles the original build once, preserving source and result binding',async t=>{
 const f=await fixture(t,{lost:true}),a=await f.api.submit('owner','p',f.input);
 assert.equal((await f.api.submit('owner','p',f.input)).id,a.id);
 await f.api.runOne();assert.equal((await f.api.get('owner','p',a.id)).state,'unknown');f.advance();await f.api.runOne();
 assert.equal(f.calls(),1);assert.equal(f.inspections(),1);assert.equal((await f.api.get('owner','p',a.id)).state,'compiled');
 assert.equal((await f.api.artifact('owner','p',a.id)).planId,a.planId);
 await assert.rejects(f.api.submit('owner','p',{...f.input,snapshotId:'other'}),{code:'idempotency_conflict'});
});
test('private sources and absent public consent never dispatch or create a job',async t=>{
 const f=await fixture(t);await assert.rejects(f.api.submit('owner','p',{...f.input,publishSource:false}),{code:'oci_public_source_consent_required'});
 f.withdraw();await assert.rejects(f.api.submit('owner','p',f.input),{code:'not_found'});assert.equal(f.calls(),0);assert.equal((await f.store.list('workflow-jobs')).length,0);
});
test('revocation before dispatch and after dispatch cannot publish new output',async t=>{
 const f=await fixture(t),a=await f.api.submit('owner','p',f.input);f.revoke();await f.api.runOne();assert.equal(f.calls(),0);assert.equal((await f.api.get('owner','p',a.id)).state,'blocked');
 const g=await fixture(t),b=await g.api.submit('owner','p',g.input);await g.api.runOne();g.revoke();g.advance();await g.api.runOne();assert.equal(g.inspections(),1);assert.equal((await g.api.get('owner','p',b.id)).state,'blocked');await assert.rejects(g.api.artifact('owner','p',b.id),{code:'build_not_complete'});
});
test('disabled admission is explicit, cancellation hides public build source, and capacity stays bounded',async t=>{
 const disabled=await fixture(t,{enabled:false});await assert.rejects(disabled.api.submit('owner','p',disabled.input),{code:'oci_builds_not_enabled'});
 const f=await fixture(t),a=await f.api.submit('owner','p',f.input);await assert.rejects(f.api.submit('owner','p',{...f.input,idempotencyKey:'other'}),{code:'oci_build_capacity_reached'});
 await f.jobs.cancel('owner','p',a.id);await assert.rejects(f.api.publicSource(a.id),{code:'not_found'});
});
test('a mismatched receipt never becomes a completed build or a fresh dispatch',async t=>{
 const f=await fixture(t),a=await f.api.submit('owner','p',f.input);await f.api.runOne();f.advance();const inspect=f.ports.inspect;f.ports.inspect=async v=>{const r=await inspect(v);r.receipt.sourceHash=digest('wrong');return r;};await f.api.runOne();assert.equal((await f.api.get('owner','p',a.id)).state,'unknown');assert.equal(f.calls(),1);await assert.rejects(f.api.artifact('owner','p',a.id),{code:'build_not_complete'});
});
test('API and MCP share explicit public-source consent and expose no arbitrary runner or wallet',()=>{
 for(const name of ['resource_build','resource_build_status','resource_build_artifact','resource_build_source'])assert(ROUTES.some(r=>r.name===name));
 const route=ROUTES.find(r=>r.name==='resource_build');const good={projectId:'p',snapshotId:digest('snapshot'),publishSource:true,idempotencyKey:'once'};validate(route.inputSchema,good);assert.throws(()=>validate(route.inputSchema,{...good,runnerUrl:'https://other.example'}));
 const plan=createOciBuildPlan({projectId:'p',snapshotId:'s',files:[{path:'Dockerfile',content:'FROM scratch'}]});assert.equal(plan.evidence,'source_plan_only');
});
