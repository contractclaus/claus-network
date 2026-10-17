import test from 'node:test';import assert from 'node:assert/strict';
import {flyTarget,flyApps} from '../src/infrastructure/fly-target.mjs';
const config={id:'small-cpu',provider:'fly',organization:'claus-network',projectIsolation:true};
test('projects receive stable separate apps and private networks',()=>{
 const a=flyTarget(config,'prj_first'),b=flyTarget(config,'prj_second');assert.notEqual(a.app,b.app);assert.equal(a.network,a.app);assert.deepEqual(flyTarget(config,'prj_first'),a);
 assert.throws(()=>flyTarget({...config,organization:'other'},'prj_first'));
 assert.throws(()=>flyTarget({...config,projectId:'prj_first',app:a.app},'prj_second'));
});
test('existing app on a different network is never adopted',async()=>{
 const c=flyTarget(config,'prj_first');const apps=flyApps({token:()=>'',request:async()=>Response.json({apps:[{name:c.app,network:'default'}]})});
 await assert.rejects(apps.prepare(c),/project_network_not_isolated/);
});
test('app setup is idempotent and allocates only shared IPv4',async()=>{
 const c=flyTarget(config,'prj_first');let created=false,ip=false;const writes=[];
 const apps=flyApps({token:()=>'',request:async(url,init)=>{
  const body=init.body?JSON.parse(init.body):null;if(init.method==='POST')writes.push(body);
  if(url.endsWith('/apps')&&init.method==='POST'){created=true;assert.equal(body.network,c.app);return Response.json({id:c.app});}
  if(url.includes('/apps?'))return Response.json({apps:created?[{name:c.app,network:c.network}]:[]});
  if(url.endsWith('/graphql')){if(body.query.startsWith('mutation')){assert.equal(body.variables.input.type,'shared_v4');ip=true;return Response.json({data:{allocateIpAddress:{app:{id:c.app,sharedIpAddress:'1.2.3.4'}}}});}return Response.json({data:{app:{id:c.app,sharedIpAddress:ip?'1.2.3.4':null}}});}
  return Response.json({organization:{slug:'claus-network'}});
 }});
 await apps.prepare(c,{publicHttp:true});await apps.prepare(c,{publicHttp:true});
 assert.equal(writes.filter(w=>w.app_name).length,1);assert.equal(writes.filter(w=>w.query?.startsWith('mutation')).length,1);
});
