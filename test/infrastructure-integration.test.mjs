import test from 'node:test';
import assert from 'node:assert/strict';
import {createApplication} from '../runtime/server.mjs';
import {openStore} from '../src/storage/index.mjs';
import {digest} from '../src/shared/index.mjs';
import {infrastructureCycle} from '../runtime/infrastructure-cycle.mjs';

test('real HTTP and MCP expose the same private source plan and fail closed without funded providers',async t=>{
 const store=openStore(':memory:');t.after(()=>store.close());
 const at=Date.now(),token='cln_'+'a'.repeat(43),other='cln_'+'b'.repeat(43),actor=digest(token),project='prj_infrastructure';
 const app=createApplication({store,rateSalt:'test-only'.repeat(8),now:()=>at});
 await store.transaction(async tx=>{
  await tx.write('credentials',actor,{kind:'owner',principalId:'owner',expiresAt:at+3600000},0);
  await tx.write('credentials',digest(other),{kind:'owner',principalId:'stranger',expiresAt:at+3600000},0);
  await tx.write('projects',project,{id:project,ownerId:'owner',name:'private source'},0);
 });
 const snapshot=await app.projects.createSnapshot(actor,project,{expectedProjectRevision:1,files:[{path:'Dockerfile',content:'FROM scratch\nCOPY data.txt /data.txt\n'},{path:'data.txt',content:'private-source-only'}]});
 const call=(path,method='GET',body,auth=token)=>app.fetch(new Request('https://claus.si'+path,{method,headers:{authorization:'Bearer '+auth,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}));
 const response=await call(`/v1/projects/${project}/infrastructure/build-plan`,'POST',{snapshotId:snapshot.id});
 assert.equal(response.status,200);const plan=await response.json();assert.equal(plan.source,undefined);assert.equal(plan.evidence,'source_plan_only');assert(!JSON.stringify(plan).includes('private-source-only'));
 const mcp=await app.fetch(new Request('https://claus.si/mcp',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'resource_build_plan',arguments:{projectId:project,snapshotId:snapshot.id}}})}));
 assert.deepEqual((await mcp.json()).result.structuredContent,plan);
 assert.equal((await call(`/v1/projects/${project}/infrastructure/build-plan`,'POST',{snapshotId:snapshot.id},other)).status,403);
 const profiles=await call(`/v1/projects/${project}/infrastructure/profiles`);assert.deepEqual(await profiles.json(),{items:[]});
 const result=await call(`/v1/projects/${project}/infrastructure/quotes`,'POST',{profileId:'missing',manifest:{version:1,mode:'job',image:'ghcr.io/contractclaus/example@sha256:'+'a'.repeat(64),region:'test',cpu:1,memoryMiB:256,gpu:null,port:null,healthPath:null,command:[],storageGiB:0,releaseHash:digest('release')},leaseSeconds:60,idempotencyKey:'original'});
 assert.equal(result.status,409);assert.equal((await result.json()).error,'infrastructure_not_enabled');
 assert.deepEqual(await infrastructureCycle({infrastructure:app.infrastructure,store}),{state:'not_configured',processed:0});
});

test('the controller excludes concurrent observers and resumes its existing cursor after failure',async t=>{
 const store=openStore(':memory:');t.after(()=>store.close());let release,seen=[];
 const infrastructure={discovery:async()=>({reconciliation:true}),tick:async input=>{seen.push(input.after);await new Promise(resolve=>{release=resolve;});return {processed:1,nextCursor:'original-resource'};}};
 const first=infrastructureCycle({infrastructure,store});
 while(!release)await new Promise(setImmediate);
 assert.deepEqual(await infrastructureCycle({infrastructure,store}),{state:'running',processed:0});release();await first;
 infrastructure.tick=async input=>{seen.push(input.after);throw Error('provider unavailable');};
 assert.equal((await infrastructureCycle({infrastructure,store})).state,'unavailable');
 assert.deepEqual(seen,['','original-resource']);assert.equal((await store.read('controller-cursors','infrastructure')).value.after,'original-resource');
});

test('the controller wraps an exhausted cursor in the same pass without exceeding one resource',async t=>{
 const store=openStore(':memory:');t.after(()=>store.close());
 await store.transaction(tx=>tx.write('controller-cursors','infrastructure',{after:'last-resource',token:null,leaseUntil:0},0));
 const seen=[];const infrastructure={discovery:async()=>({reconciliation:true}),tick:async input=>{
  seen.push(input);return input.after?{processed:0,nextCursor:null}:{processed:1,nextCursor:'first-resource'};
 }};
 const result=await infrastructureCycle({infrastructure,store});
 assert.equal(result.processed,1);assert.deepEqual(seen,[{after:'last-resource',limit:1},{after:'',limit:1}]);
 assert.equal((await store.read('controller-cursors','infrastructure')).value.after,'first-resource');
});
