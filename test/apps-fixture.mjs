
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {openStore} from '../src/storage/index.mjs';import {memoryAppStore} from '../src/app-storage/index.mjs';
import {createApplication} from '../runtime/server.mjs';import {createAgentClient} from '../interfaces/agent-client.mjs';
const scalar={type:'object',properties:{text:{type:'string',maxLength:200}},required:['text'],additionalProperties:false};
export const manifest={name:'Agent board',description:'Private acceptance fixture',participation:'open',collections:[{id:'posts',visibility:'public',schema:scalar},{id:'notes',visibility:'author',schema:scalar}],tasks:{visibility:'public',inputSchema:scalar,outputSchema:scalar,leaseSeconds:30}};
export async function fixture(t,provided={}){
 const store=provided.store??openStore(':memory:');if(!provided.store)t.after(()=>store.close());let time=Date.now();
 const app=createApplication({store,appStorage:provided.appStorage??memoryAppStore(store),dealPorts:provided.dealPorts??{},origin:'https://claus.test',rateSalt:'x'.repeat(32),now:()=>time});
 const requester=async(url,opt)=>app.fetch(new Request(url,opt),{peer:'fixture'});
 const makeClient=()=>createAgentClient({account:privateKeyToAccount(generatePrivateKey()),origin:'https://claus.test',fetch:requester,now:()=>time});
 const owner=makeClient(),bob=makeClient(),eve=makeClient();
 await store.transaction(async tx=>{await tx.write('network-capabilities','collaboration',{enabled:true},0);});
 const op=await owner.call('principal_me');await store.transaction(tx=>tx.write('network','authority',{ownerAddress:op.principal.address},0));
 const project=await owner.call('project_create',{slug:'agent-board',name:'Agent board',idempotencyKey:'project'});
 // Activate public nonfinancial collaboration through the existing owner API.
 const access=await owner.call('access_policy_get');await owner.call('access_policy_publish',{version:'apps-test',config:{...access.config,publicCollaboration:true}});await owner.call('access_policy_activate',{version:'apps-test',expectedGeneration:access.generation});
 await owner.call('project_publish',{projectId:project.id,published:true,expectedRevision:0});
 const a=await owner.call('app_configure',{projectId:project.id,manifest,expectedRevision:0,idempotencyKey:'app'});await owner.call('app_publish',{projectId:project.id,published:true,expectedRevision:a.revision,idempotencyKey:'publish'});
 for(const client of [bob,eve])await client.call('app_join',{projectId:project.id,idempotencyKey:'join'});
 return {app,store,owner,bob,eve,project,advance:n=>{time+=n;}};
}
