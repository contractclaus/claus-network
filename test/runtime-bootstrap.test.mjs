import test from 'node:test';
import assert from 'node:assert/strict';
import {openRuntime} from '../runtime/bootstrap.mjs';
import {startRuntimeServer} from '../runtime/server.mjs';
const local={CLAUS_NETWORK_LOCAL:'1',CLAUS_NETWORK_LOCAL_FILE:':memory:',CLAUS_NETWORK_RATE_SALT:'local-verification-'.repeat(3),PORT:'0'};
test('portable construction includes OCI and infrastructure ports without starting any work',async()=>{
 const runtime=await openRuntime({allowLocal:true,env:{...local,CRON_SECRET:'local-test-secret',CLAUS_OCI_BUILDS_ENABLED:'1',CLAUS_INFRASTRUCTURE_ENABLED:'1'}});
 try{assert.equal(runtime.app.ociBuilds.discovery().enabled,true);assert.equal((await runtime.app.infrastructure.discovery()).providerExecution,true);assert.equal((await runtime.store.list('workflow-jobs')).length,0);assert.equal((await runtime.store.list('infrastructure-resources')).length,0);assert.deepEqual(await runtime.databaseBoundary(),{profile:'local-sqlite',verified:false});}
 finally{await runtime.close();await runtime.close();}
});
test('production cannot silently fall back to SQLite or advertise missing persistent app storage',async()=>{
 await assert.rejects(openRuntime({env:local}),{code:'database_required'});
 await assert.rejects(openRuntime({allowLocal:true,env:{...local,CLAUS_APPS_ENABLED:'1'}}),{code:'local_app_storage_unavailable'});
});
test('real standalone HTTP binds for containers, serves health and closes idempotently',async()=>{
 const runtime=await startRuntimeServer({env:local});
 try{assert.equal(runtime.server.address().address,'0.0.0.0');const root='http://127.0.0.1:'+runtime.server.address().port;
 const response=await fetch(root+'/health');assert.equal(response.status,200);const value=await response.json();assert.equal(value.service,'Claus Network');assert.equal(value.status,'ok');assert.equal(value.databaseBoundary.verified,false);
 const head=await fetch(root+'/health',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
 const caps=await fetch(root+'/v1/public/capabilities');assert.equal(caps.status,200);}
 finally{await Promise.all([runtime.close(),runtime.close()]);}
 assert.equal(runtime.server.listening,false);
});
