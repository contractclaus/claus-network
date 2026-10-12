import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {Pool, neonConfig} from '@neondatabase/serverless';
import ws from 'ws';
import {openPostgresStore} from '../src/postgres/index.mjs';
import {createNetwork} from '../src/index.mjs';
import {digest} from '../src/shared/index.mjs';
neonConfig.webSocketConstructor=ws;
const credentials=process.env.NETWORK_TEST_CREDENTIAL_FILE;
const OWNER='0xbb145ca83272c3806d4ddc75ca1d5514789cf1c5';
const SPONSOR='sponsor:'+OWNER;
const ASSET='test:postgres/REVIEW';
const INPUT=digest({source:'explicitly-simulated-test-input'});

test('PostgreSQL: atomic money, replay, policy pinning, transaction authorization and recovery',
 {skip:!credentials,timeout:180000},async t=>{
 const settings=JSON.parse(await readFile(credentials,'utf8'));
 const schema='acceptance_'+randomBytes(8).toString('hex');
 const makePool=()=>new Pool({connectionString:settings.migrationUrl,connectionTimeoutMillis:10000,max:4});
 const pool=makePool();
 const store=await openPostgresStore({pool,schema,migrate:true});
 let store2=await openPostgresStore({pool:makePool(),schema});
 t.after(async()=>{await store2.close();await pool.query(`DROP SCHEMA "${schema}" CASCADE`);await store.close();});
 let serial=0,time=1800000000000;
 const verified=new Map();
 const check=async(actor,action,scope,reader)=>{
  if(actor===OWNER||actor==='worker')return true;
  if(!['review.quote','review.admit','review.read'].includes(action)||actor!==scope.projectId)return false;
  return !(await (reader??store).read('revocations',actor));
 };
 const options={ownerAddress:OWNER,authorize:check,now:()=>time,verifyCost:receipt=>verified.get(receipt.id)===digest(receipt),
  provider:{id:'test-provider',quote:async({inputHash})=>({id:'offer-'+ ++serial,provider:'test-provider',asset:ASSET,maximum:'100',expiresAt:time+60000,inputHash})}};
 const api=createNetwork({...options,store});
 let api2=createNetwork({...options,store:store2});
 await api.bootstrap({actor:OWNER});
 await api.billing.recordFunding({actor:OWNER,account:SPONSOR,asset:ASSET,amount:'100',receiptId:'test-deposit-1'});
 const quote=(actor,id)=>api.reviews.quote({actor,id,projectId:actor,inputHash:INPUT});
 const q1=await quote('alice','q1'),q2=await quote('bob','q2');
 const request=q=>({actor:q.projectId,projectId:q.projectId,quoteId:q.id,inputHash:INPUT,idempotencyKey:'one-action'});
 const concurrent=await Promise.allSettled([api.reviews.admit(request(q1)),api2.reviews.admit(request(q2))]);
 assert.equal(concurrent.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(concurrent.find(x=>x.status==='rejected').reason.code,'funding_insufficient');
 const job=concurrent.find(x=>x.status==='fulfilled').value;
 const q=job.quoteId==='q1'?q1:q2;
 const balance=()=>api.billing.balance({actor:OWNER,account:SPONSOR,asset:ASSET});
 assert.equal((await balance()).reserved,'100');
 assert.equal((await balance()).available,'0');
 assert.deepEqual(await api2.reviews.admit(request(q)),job);
 await assert.rejects(api.reviews.admit({...request(q),idempotencyKey:'different'}),{code:'quote_already_admitted'});
 await api.reviews.markUnknown({actor:'worker',projectId:job.projectId,jobId:job.id});
 await store2.close();store2=await openPostgresStore({pool:makePool(),schema});api2=createNetwork({...options,store:store2});
 assert.equal((await api2.reviews.job({actor:job.projectId,projectId:job.projectId,jobId:job.id})).work,'outcome_unknown');
 const receipt={id:'test-receipt',provider:q.offer.provider,providerQuoteId:q.offer.id,inputHash:INPUT,asset:ASSET,actual:'60'};
 await assert.rejects(api.reviews.recordCost({actor:'worker',projectId:job.projectId,jobId:job.id,receipt}),{code:'cost_not_verified'});
 verified.set(receipt.id,digest(receipt));
 const settlement={actor:'worker',projectId:job.projectId,jobId:job.id,receipt};
 await Promise.all([api.reviews.recordCost(settlement),api2.reviews.recordCost(settlement)]);
 assert.deepEqual(await balance(),{account:SPONSOR,asset:ASSET,available:'40',reserved:'0',spent:'60'});
 // Changing fees cannot change terms in the already accepted offer.
 await api.policies.publish({actor:OWNER,module:'review.fees',version:'v2',config:{rateBps:100,flatByAsset:{}}});
 await api.policies.activate({actor:OWNER,module:'review.fees',version:'v2',expectedGeneration:1});
 assert.equal((await api.reviews.quote({actor:q.projectId,projectId:q.projectId,id:q.id,inputHash:INPUT})).maximum.project,'0');
 await api.policies.activate({actor:OWNER,module:'review.fees',version:'launch-v1',expectedGeneration:2});
 assert.equal((await api2.policies.active('review.fees')).generation,3);
 await assert.rejects(api2.policies.activate({actor:OWNER,module:'review.fees',version:'v2',expectedGeneration:1}),{code:'revision_conflict'});
 // The caller was checked before locking; revoke before the transition obtains the lock.
 const blockedQuote=await quote('charlie','revoke-between-check-and-lock');
 await store.transaction(tx=>tx.write('revocations','charlie',{at:time},0));
 await assert.rejects(api2.reviews.admit(request(blockedQuote)),{code:'access_denied'});
 assert.equal((await balance()).spent,'60');
 // A failed two-account reservation rolls back its first balance movement.
 await api.billing.recordFunding({actor:OWNER,account:SPONSOR,asset:ASSET,amount:'100',receiptId:'test-deposit-2'});
 await api.policies.activate({actor:OWNER,module:'review.fees',version:'v2',expectedGeneration:3});
 const charged=await quote('dana','second-account-failure');
 await assert.rejects(api2.reviews.admit(request(charged)),{code:'funding_insufficient'});
 assert.equal((await balance()).available,'140');
 assert.equal((await balance()).reserved,'0');
 t.diagnostic('All effects confined to a disposable acceptance schema; provider and funding receipts are explicit test fixtures.');
});
