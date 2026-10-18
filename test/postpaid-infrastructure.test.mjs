import test from 'node:test';import assert from 'node:assert/strict';
import {openStore} from '../src/storage/index.mjs';import {createInfrastructure} from '../src/infrastructure/index.mjs';import {digest} from '../src/shared/index.mjs';
test('owned postpaid leases retain unknown obligations without minting deposits, consuming lifetime cash quotas or repeating dispatch',async t=>{
 const store=openStore(':memory:');t.after(()=>store.close());const now=1000000;let creates=0,seen=null;
 const identity={credential:async()=>({kind:'owner',principalId:'owner'}),authorize:async()=>true};
 await store.transaction(async tx=>{for(const [c,id,v] of [['principals','owner',{chainId:1,address:'0xowner'}],['network','authority',{ownerAddress:'0xowner'}],['network-capabilities','continuous-operation',{enabled:true,profile:'claus-operation-v1',expiresAt:null}],['projects','owned',{ownerId:'owner'}],['projects','foreign',{ownerId:'other'}]])await tx.write(c,id,v,0);});
 const profile={id:'fly-card',provider:'fly',accountId:'claus-network',asset:'USD',fundingAccount:'postpaid:fly:claus-network',billingMode:'postpaid',enabled:true,permissionHash:digest('owner grant'),maxLeaseSeconds:3600,maxPerLease:'200000000',maxActive:10,imagePrefixes:['ghcr.io/contractclaus/'],regions:['ams'],maxCpu:8,maxMemoryMiB:65536,maxStorageGiB:0,gpuTypes:[]};
 const ports={verifyRelease:async()=>true,quote:async r=>({id:digest(r),requestHash:r.requestHash,accountId:profile.accountId,asset:'USD',maximum:'10000000',expiresAt:now+10000,totalLifecycle:true}),create:async w=>{creates++;seen={operationId:w.id,accountId:profile.accountId,providerResourceId:'machine',ready:true};throw Error('response lost');},inspect:async()=>seen};
 const api=createInfrastructure({store,identity,ports,enabled:true,now:()=>now});
 await api.control.configure('owner',{profile,operators:['owner'],enabled:true,expiresAt:null,totalLimit:'200000000',perProjectLimit:'20000000',dailyLimit:'200000000',expectedRevision:0});
 await api.control.grant('owner','owned',{profileId:profile.id,enabled:true,expiresAt:null,limit:'20000000',expectedRevision:0,idempotencyKey:'grant',reason:'Owner delegated operating service'});
 const manifest={version:1,mode:'job',image:'ghcr.io/contractclaus/app@sha256:'+'a'.repeat(64),region:'ams',cpu:2,memoryMiB:4096,gpu:null,port:null,healthPath:null,command:[],storageGiB:0,releaseHash:digest('release')};
 const resources=[];for(let i=0;i<3;i++){const q=await api.quote('owner','owned',{profileId:profile.id,manifest,leaseSeconds:300,idempotencyKey:'q'+i});resources.push(await api.request('owner','owned',{quoteId:q.id,idempotencyKey:'r'+i}));}
 assert.equal((await store.list('balances',{limit:100})).length,0);assert.equal((await store.list('funding-receipts',{limit:100})).length,0);
 assert.equal((await store.list('infrastructure-postpaid-obligations',{limit:100}))[0].value.reserved,'30000000');
 await api.reconcile(resources[0].id);await api.reconcile(resources[0].id);assert.equal(creates,1);assert.equal((await api.get('owner','owned',resources[0].id)).state,'running');
 await assert.rejects(api.control.grant('owner','foreign',{profileId:profile.id,enabled:true,expiresAt:null,limit:'20000000',expectedRevision:0,idempotencyKey:'foreign',reason:'not authorized'}),{code:'postpaid_owned_project_required'});
 const grant=(await api.profiles('owner','owned')).items[0].allowance;
 await api.control.grant('owner','owned',{profileId:profile.id,enabled:false,expiresAt:null,limit:'0',expectedRevision:grant.revision,idempotencyKey:'revoke',reason:'Owner revoked'});
 assert.equal((await store.list('infrastructure-postpaid-obligations',{limit:100}))[0].value.reserved,'30000000');
});
