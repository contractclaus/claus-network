import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {managedBuilds} from '../src/resources/builds.mjs';
import {buildWorkflow} from '../src/resources/build-workflow.mjs';
import {digest} from '../src/resources/store.mjs';
function fixture(){
 const records=new Map(),resource={id:'res_'+('1'.repeat(24)),provider:'github',providerId:'12',name:'claus-build-source',owner:'contractclaus'},sha='a'.repeat(40),workflowSha=createHash('sha1').update('blob '+Buffer.byteLength(buildWorkflow)+'\0'+buildWorkflow).digest('hex');
 records.set('resource:'+resource.id,resource);
 records.set('build-definition:'+resource.id+':'+workflowSha,{commit:sha});
 const store={async get(k,id){return structuredClone(records.get(k+':'+id)??null);},async put(k,id,v){const key=k+':'+id;if(!records.has(key))records.set(key,structuredClone(v));return {value:await this.get(k,id)};},async begin(id,operation,input,prepared){await this.put('action',id,{operation,input,prepared,phase:'prepared'});return {row:{result:await this.get('action',id)}};},async dispatch(id){const row=records.get('action:'+id);if(row.phase!=='prepared')return false;row.phase='dispatched';return true;},async complete(id,output){records.get('action:'+id).output=output;return output;}};
 let dispatches=0,tag=null,observed=null,tampered=false;const reservations=[];
 const providers={async call(provider,path,options={}){
  if(path.endsWith('/claus-build-source'))return {id:12,private:true,owner:{login:'contractclaus'},default_branch:'main'};
  if(path.includes('/contents/'))return {sha:tampered?'b'.repeat(40):workflowSha};
  if(path.includes('/git/commits/'))return {sha};
  if(path.includes('/git/ref/heads/'))return {object:{sha}};
  if(path.includes('/git/ref/tags/'))return tag;
  if(path.endsWith('/git/refs')){tag={object:{sha}};return tag;}
  if(path.endsWith('/dispatches')){dispatches++;throw Error('connection_lost_after_dispatch');}
  if(path.includes('/runs?'))return {workflow_runs:observed?[observed]:[]};
  if(path.endsWith('/runs/81'))return observed;
  throw Error('unexpected '+path);
 }};
 const service=managedBuilds({store,providers,budget:async(op,id,max)=>reservations.push({op,id,max}),prices:async()=>({perMinuteMicroUsd:{amd64:6000,arm64:5000}}),environment:{}});
 const input={resourceId:resource.id,commit:sha,mode:'command',command:'npm run build',timeoutMinutes:300};
 return {service,input,reservations,get dispatches(){return dispatches;},tamper(){tampered=true;},observe(id){observed={id:81,display_title:'Claus build '+id,head_sha:sha,event:'workflow_dispatch',repository:{id:12},run_attempt:1,status:'queued',html_url:'https://github.com/contractclaus/claus-build-source/actions/runs/81'};}};
}
test('lost dispatch response preserves one paid run, original ID and reservation',async()=>{
 const f=fixture(),request='long-production-build',id='act_'+digest(['owner',request]).slice(0,24);
 await assert.rejects(f.service.call('build_start',f.input,request),/connection_lost_after_dispatch/);
 const pending=await f.service.call('build_start',f.input,request);assert.equal(pending.state,'outcome_unknown');assert.equal(f.dispatches,1);assert(!f.reservations.some(x=>x.op==='cancel'));
 f.observe(id);const recovered=await f.service.call('build_start',f.input,request);assert.equal(recovered.runId,81);assert.equal(recovered.actionId,id);assert.equal(f.dispatches,1);
 assert(f.reservations.some(x=>x.op==='commit'));assert.deepEqual(await f.service.call('build_start',f.input,request),recovered);
 await assert.rejects(f.service.call('build_start',{...f.input,command:'another command'},request),/request_conflict/);
});
test('changed workflow is rejected before a paid dispatch',async()=>{
 const f=fixture();f.tamper();await assert.rejects(f.service.call('build_start',f.input,'tampered'),/install_current_workflow_first/);assert.equal(f.dispatches,0);assert.equal(f.reservations.length,0);
 assert(buildWorkflow.includes('if: github.run_attempt == 1'));assert(buildWorkflow.includes("steps.bounded-result.outcome == 'success'"));assert(!buildWorkflow.includes('pull_request:'));
});
