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


test('an owned specialist can be shown on a public product without publishing its private runtime project', async () => {
  const {agentPublicationVisible}=await import('../src/projects/agent-publication.mjs');
  const {createCollaboration}=await import('../src/collaboration/index.mjs');
  const docs=new Map(), key=(c,id)=>c+':'+id;
  const put=(c,id,value)=>docs.set(key(c,id),{value,revision:1});
  const source={id:'prj_internal',ownerId:'owner',slug:'internal'},destination={id:'prj_product',ownerId:'owner',slug:'product'};
  put('projects',source.id,source);put('projects',destination.id,destination);
  put('public-projects','product',{projectId:destination.id,slug:'product',name:'Product',published:true});
  put('principals','agent_worker',{id:'agent_worker',projectId:source.id,kind:'agent',name:'Observation worker'});
  const writes=[];const store={read:async(c,id)=>docs.get(key(c,id)),
    list:async(c,{prefix=''})=>[...docs].filter(([k])=>k.startsWith(c+':'+prefix)).map(([k,v])=>({id:k.slice(c.length+1),...v})),
    write:async(c,id,value,revision)=>{assert.equal(docs.get(key(c,id))?.revision??0,revision);const row={value,revision:revision+1};docs.set(key(c,id),row);writes.push(c);return row;},event:async()=>{},transaction:async fn=>fn(store)};
  const identity={authorize:async(actor,scope,{projectId})=>{if((await store.read('projects',projectId)).value.ownerId!==actor)throw Object.assign(Error('denied'),{code:'scope_denied'});},
    owner:async(actor,projectId)=>{await identity.authorize(actor,'project.publish',{projectId});return {project:(await store.read('projects',projectId)).value};},credential:async actor=>({principalId:actor})};
  const projects=createProjects({store,identity});
  await assert.rejects(projects.publishAgent('stranger',destination.id,{agentId:'agent_worker',published:true,expectedRevision:0}),{code:'scope_denied'});
  const result=await projects.publishAgent('owner',destination.id,{agentId:'agent_worker',published:true,expectedRevision:0});
  assert.equal(result.name,'Observation worker');assert(!JSON.stringify(result).includes('internal'));
  const project=await projects.publicProject('product');assert.equal(project.agents[0].relationship,'owned');
  assert(!JSON.stringify(project).includes('internal'));assert.equal(await store.read('public-projects','internal'),undefined);
  const collaboration=createCollaboration({store,identity,visible:async()=>true,admit:async()=>{}});
  await collaboration.set('owner',destination.id,{agentId:'agent_worker',skills:['validation'],availability:'unavailable',description:'Owned contributor',role:'builder',quote:null,published:true,expectedRevision:0,idempotencyKey:'profile'});
  assert.equal((await collaboration.get(destination.id,'agent_worker')).name,'Observation worker');
  const publication=(await store.read('project-public-agents',destination.id+':agent_worker')).value;
  assert.equal(await agentPublicationVisible(store,publication),true);
  source.ownerId='new-owner';assert.equal(await agentPublicationVisible(store,publication),false);
  assert.equal((await projects.publicProject('product')).agents.length,0);
  await assert.rejects(collaboration.get(destination.id,'agent_worker'),{code:'not_found'});
  await assert.rejects(projects.publishAgent('owner',destination.id,{agentId:'agent_worker',published:true,expectedRevision:1}),{code:'scope_denied'});
  await projects.publishAgent('owner',destination.id,{agentId:'agent_worker',published:false,expectedRevision:1});
  await collaboration.set('owner',destination.id,{agentId:'agent_worker',skills:[],availability:'unavailable',description:'',role:'builder',quote:null,published:false,expectedRevision:1,idempotencyKey:'withdraw'});
  assert(writes.every(c=>['project-public-agents','agent-work-profiles','agent-profile-requests'].includes(c)));
  assert.equal((await store.read('principals','agent_worker')).value.projectId,source.id);
});
