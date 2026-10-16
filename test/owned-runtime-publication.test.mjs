import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjects} from '../src/projects/index.mjs';
import {digest} from '../src/shared/index.mjs';

test('publication names the existing bound runtime agent without exposing or changing its authority', async () => {
  const projectId='prj_own', runtimeId='projectcheck-observation', id=projectId+':'+runtimeId;
  const agentId='runtime_'+digest({id}).slice(7);
  let principal={id:agentId,projectId,kind:'agent'}, rows=[{id,value:{projectId,runtimeId,actor:'private-credential',memory:{secret:'private-input'}}}], denied=false;
  const writes=[];
  const tx={
    read:async(collection,key)=>{assert.equal(collection,'principals');assert.equal(key,agentId);return{value:principal};},
    list:async(collection,options)=>{assert.equal(collection,'project-runtimes');assert.deepEqual(options,{projectId,limit:5});return rows;},
    write:async(collection,key,value,revision)=>{assert.equal(collection,'project-public-agents');assert.equal(key,projectId+':'+agentId);writes.push(value);return{value,revision:revision+1};},
    event:async()=>{}
  };
  const api=createProjects({store:{transaction:fn=>fn(tx)},identity:{authorize:async(actor,scope,context)=>{assert.equal(scope,'project.publish');assert.equal(context.projectId,projectId);if(denied)throw Object.assign(Error('denied'),{code:'scope_denied'});}}});
  const input={agentId,published:true,expectedRevision:0};
  const published=await api.publishAgent('owner',projectId,input);
  assert.deepEqual(published,{projectId,agentId,name:'projectcheck observation',published:true,revision:1});
  assert(!JSON.stringify(published).includes('private'));
  assert.equal(principal.name,undefined);
  principal={...principal,name:'Existing named agent'};
  assert.equal((await api.publishAgent('owner',projectId,input)).name,'Existing named agent');
  delete principal.name;
  rows=[{id,value:{projectId:'prj_other',runtimeId}}];
  await assert.rejects(api.publishAgent('owner',projectId,input),{code:'invalid_agent_name'});
  rows=[{id:projectId+':different',value:{projectId,runtimeId}}];
  await assert.rejects(api.publishAgent('owner',projectId,input),{code:'invalid_agent_name'});
  assert.equal((await api.publishAgent('owner',projectId,{...input,published:false})).published,false);
  const before=writes.length;denied=true;
  await assert.rejects(api.publishAgent('outsider',projectId,input),{code:'scope_denied'});
  assert.equal(writes.length,before);
});
