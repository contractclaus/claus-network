import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createHash,createHmac} from 'node:crypto';
import {fixture} from './oci-builds.test.mjs';
import {openStore} from '../src/storage/index.mjs';
import {createJobs} from '../src/jobs/index.mjs';
import {createBuilds} from '../src/builds/index.mjs';
import {createArtifactStore} from '../src/artifact-store/index.mjs';
import {createR2Objects} from '../adapters/r2-objects.mjs';
import {inferencePorts} from '../runtime/inference-ports.mjs';
import {ociPorts} from '../runtime/oci-ports.mjs';
import {canonical} from '../src/shared/index.mjs';
import {errorBody,errorStatus} from '../interfaces/http.mjs';
import compileHandler from '../api/compile.mjs';

test('proven pre-dispatch interruption resumes one original job; unsigned observations and revocation cannot dispatch',async t=>{
 const f=await fixture(t,{lost:true}),a=await f.api.submit('owner','p',f.input);
 await f.api.runOne();f.advance();
 f.ports.inspect=async v=>({buildId:v.id,state:'not_started'});
 f.ports.verifyObservation=async()=>false;
 await f.api.runOne();assert.equal(f.calls(),1);
 f.advance();f.ports.verifyObservation=async()=>true;
 f.ports.dispatch=async v=>({buildId:v.id,state:'running'});
 await f.api.runOne();assert.equal((await f.api.get('owner','p',a.id)).state,'running');
 assert.equal((await f.store.list('workflow-jobs')).length,1);
 f.advance();f.revoke();let attempts=0;f.ports.dispatch=async()=>{attempts++;};await f.api.runOne();
 assert.equal(attempts,0);assert.equal((await f.api.get('owner','p',a.id)).state,'blocked');
});
test('unknown outcomes back off, preserve run context, and report capacity retry time',async t=>{
 const f=await fixture(t,{lost:true}),a=await f.api.submit('owner','p',f.input);await f.api.runOne();
 const first=(await f.api.get('owner','p',a.id)).nextCheckAt;f.advance();f.ports.inspect=async()=>{throw Error('temporary');};await f.api.runOne();
 const next=(await f.api.get('owner','p',a.id)).nextCheckAt;assert(next>first+60000);
 await assert.rejects(f.api.submit('owner','p',{...f.input,idempotencyKey:'new'}),e=>{assert.equal(errorStatus(e),429);assert(Number.isSafeInteger(errorBody(e).retryAt));return true;});
});
test('serialized source limit is enforced before job allocation; artifact expiry remains visible with original receipt',async t=>{
 const f=await fixture(t);f.projects.publicSource=async()=>({projectId:'p',snapshotId:'s',files:[{path:'Dockerfile',content:'FROM scratch'},{path:'escaped-a.txt',content:'\\'.repeat(850000)},{path:'escaped-b.txt',content:'\\'.repeat(850000)}]});
 await assert.rejects(f.api.submit('owner','p',f.input),e=>{assert.equal(errorStatus(e),413);return true;});assert.equal((await f.store.list('workflow-jobs')).length,0);
 const g=await fixture(t),a=await g.api.submit('owner','p',g.input);await g.api.runOne();g.advance();const inspect=g.ports.inspect;
 g.ports.inspect=async v=>{const result=await inspect(v);result.receipt.artifact={expiresAt:'1970-01-01T00:00:00Z'};return result;};
 await g.api.runOne();assert.equal((await g.api.artifact('owner','p',a.id)).artifactAvailability,'expired');assert.equal((await g.api.get('owner','p',a.id)).state,'compiled');
});
test('custody observations bind original work and receipt proofs reject malformed multibyte data',async()=>{
 const secret='test',work={id:'a'},result={buildId:'a',state:'not_started'};
 const observationProof=createHmac('sha256',secret).update(canonical({work,result})).digest('hex');
 const {ports}=ociPorts({env:{CRON_SECRET:secret}});
 assert(await ports.verifyObservation(work,{...result,observationProof}));assert.equal(await ports.verifyObservation({id:'b'},{...result,observationProof}),false);
 assert.equal(await ports.verify({}, {runUrl:'a',proof:'ü'.repeat(64)}),false);
});
test('R2 midstream failures resume the same pure compiler job; integrity faults remain permanent',async t=>{
 const bytes=Buffer.from('contract A {}'),sha=createHash('sha256').update(bytes).digest('hex');let broken=true;
 class GetObjectCommand{constructor(input){this.input=input;}}
 const source=await createR2Objects({accountId:'a'.repeat(32),bucket:'claus-assets',sdk:{GetObjectCommand},transport:{send:async()=>({ContentLength:bytes.length,Body:Readable.from((async function*(){if(broken){yield bytes.subarray(0,2);throw Error('socket reset');}yield bytes;})())})}});
 const store=openStore(':memory:');t.after(()=>store.close());let at=1000000,compiles=0;
 const identity={authorize:async()=>{},allowed:async()=>true},jobs=createJobs({store,identity,now:()=>at});
 const projects={snapshot:async()=>({files:[{path:'A.sol'}]}),files:async()=>[{path:'A.sol',content:(await source.read('p',sha)).bytes.toString()}]};
 const builds=createBuilds({store,identity,projects,jobs,artifacts:createArtifactStore({store}),now:()=>at});
 const input={snapshotId:'s',entry:'A.sol',contract:'A',idempotencyKey:'same'},a=await builds.submit('owner','p',input);
 const compiler=async()=>{compiles++;return {status:'compiled'};};await builds.runOne(compiler);
 assert.equal((await builds.get('owner','p',a.id)).state,'waiting');assert.equal(compiles,0);
 broken=false;at+=61000;await builds.runOne(compiler);assert.equal((await builds.get('owner','p',a.id)).state,'compiled');assert.equal(compiles,1);assert.equal((await store.list('workflow-jobs')).length,1);
 await assert.rejects(source.read('p','b'.repeat(64)),{code:'r2_object_integrity_failed'});
});
test('compiler cron rejects malformed unicode credentials without a crash or database access',async()=>{
 const old=process.env.CRON_SECRET;process.env.CRON_SECRET='aa';let status,body;
 try{await compileHandler({method:'GET',headers:{authorization:'Bearer üü'}},{setHeader(){},status(s){status=s;return this;},json(b){body=b;}});assert.equal(status,401);assert.equal(body.error,'unauthenticated');}
 finally{if(old===undefined)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=old;}
});

test('inference quote verification rejects malformed multibyte signatures',async()=>{
 const ports=inferencePorts({env:{CLAUS_COMPUTE_SECRET:'a'.repeat(32),CLAUS_COMPUTE_MODEL:'gpt-test'}});
 const profile={providerId:'surplus',accountId:'claus-network-x402-v1',model:'gpt-test',providers:['openai'],asset:'base-usdc-micro',maxOutputTokens:1024,maximumPerRequest:'1000',expiresAt:null};
 const quote=await ports.provider.quote({profile,requestHash:'request'});assert(await ports.verifyQuote(quote,profile));
 assert.equal(await ports.verifyQuote({...quote,proofHash:'ü'.repeat(quote.proofHash.length)},profile),false);
});
