import {privateNetworkTool} from '../src/tool-visibility.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DevelopmentExecution,developmentInput} from '../src/development-execution.js';
import {developmentShape,developmentNetwork} from '../src/development-profile.js';
import {mintDevelopmentGrant,readDevelopmentGrant} from '../src/external/development-grant.js';
const input={title:'Needed application',purpose:'Develop the requested application',command:'npm run build',files:[],vcpus:8,timeoutSeconds:3600};
function fixture(running=false){
 let creates=0,stops=0,snapshots=0,options:any,record:any;
 const command:any={cmdId:'cmd_original',exitCode:running?null:0,wait:async()=>({exitCode:0}),kill:async()=>{},logs:({signal}:any)=>({
  async *[Symbol.asyncIterator](){if(running)await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,1000);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});});else yield {stream:'stdout',data:'build complete'};},close(){}})};
 const session={sessionId:'session_original',writeFiles:async()=>{},runCommand:async()=>command,getCommand:async()=>command};
 const box:any={status:'running',currentSession:()=>session,currentSnapshotId:'base',snapshot:async()=>{snapshots++;return {snapshotId:'checkpoint'};},stop:async()=>{stops++;}};
 const execution=new DevelopmentExecution({create:async (value:any)=>{creates++;options=value;return box;},get:async()=>box} as any,async()=>({maximumMicroUsd:'2410000'}),10);
 return {execution,command,box,save:async(v:any)=>{record=v;},get:()=>({creates,stops,snapshots,options,record})};
}
test('selected CPU/RAM and larger file batches pass through without widening arbitrary hosts',async()=>{
 assert.equal(developmentShape(input).memoryMiB,16384);developmentInput({...input,files:Array.from({length:300},(_,i)=>({path:'source/'+i+'.txt',content:'x'}))});
 assert.throws(()=>developmentShape({...input,vcpus:3}),/profile_invalid/);
 assert.throws(()=>developmentShape({...input,networkHosts:['example.org']}),/network_work_required/);
 const custom={...input,workId:'nw_actual',networkHosts:['example.org']};assert.deepEqual(await developmentNetwork(custom,async()=>[{address:'93.184.216.34'}]),['example.org']);
 await assert.rejects(developmentNetwork(custom,async()=>[{address:'127.0.0.1'}]),/address_invalid/);
 const f=fixture();const result=await f.execution.run('development:original',input,'base',f.save);assert.equal(f.get().options.resources.vcpus,8);assert.equal(f.get().options.region,'iad1');assert.equal(f.get().stops,1);assert.equal((result as any).checkpointSnapshotId,'checkpoint');
});
test('long commands defer without stopping and recovery observes the original command before checkpointing',async()=>{
 const f=fixture(true),result=await f.execution.run('development:original',input,'base',f.save);assert.equal((result as any).pending,true);assert.equal(f.get().stops,0);
 const action={id:'development:original',input,progress:{execution:f.get().record}};
 assert.equal(await f.execution.recover(action,f.save),null);assert.equal(f.get().stops,0);assert.equal(f.get().creates,1);
 f.command.exitCode=0;f.command.logs=()=>({async *[Symbol.asyncIterator](){yield {stream:'stdout',data:'finished'};},close(){}});
 const complete=await f.execution.recover(action,f.save);assert.equal(complete?.checkpointSnapshotId,'checkpoint');assert.equal(f.get().stops,1);assert.equal(f.get().creates,1);
});
test('a funding response interrupted before creation reconciles funding without starting a second execution',async()=>{
 const f=fixture();const result=await f.execution.recover({id:'development:original',input,progress:{execution:{phase:'funding'}}},f.save);
 assert.equal((result as any).resourceCreated,false);assert.equal(f.get().creates,0);
});
test('tool bridge lifetime matches the permitted long command and still expires',()=>{
 const now=Date.now(),key='x'.repeat(40),expires=now+3660000,token=mintDevelopmentGrant('development:original',expires,key);
 assert.equal(readDevelopmentGrant(token,key,now).expires,expires);assert.throws(()=>readDevelopmentGrant(token,key,expires),/expired/);
});

test('development status remains private in tool journals',()=>assert.equal(privateNetworkTool('development_status',{}),true));
