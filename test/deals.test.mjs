import test from'node:test';import assert from'node:assert/strict';import {encodeFunctionData,decodeFunctionData}from'viem';import{fixture}from'./apps-fixture.mjs';import{dealAbi}from'../src/deals/index.mjs';import{digest}from'../src/shared/index.mjs';
import {dealPorts}from'../runtime/deal-ports.mjs';import{keccak256}from'viem';
const contract='0x1000000000000000000000000000000000000001',worker='0x2000000000000000000000000000000000000002',hash='0x'+'42'.repeat(32);
test('HTTP transaction preparation binds owner, chain, exact value and explicit recurring run without sending',async t=>{
 const requests=[],ports={context:async chainId=>({public:{enabled:true,chainId,contract,maximumDealWei:'1000',blockNumber:'5'}}),id:async()=>hash,prepare:async(c,v)=>{requests.push(v);return {transaction:{chainId:c.public.chainId,from:v.sender,to:contract,value:String(v.value),data:encodeFunctionData({abi:dealAbi,functionName:v.method,args:v.args})},gasEstimate:'100000'};}};
 const{owner,bob,project}=await fixture(t,{dealPorts:ports}),projectId=project.id,principal=await owner.call('principal_me');
 const base={projectId,chainId:11155111,action:'fund',input:{salt:hash,termsHash:hash,worker,priceWei:'100',deliveryDue:Math.floor(Date.now()/1000)+3600}};
 const p=await owner.call('deal_prepare',base);assert.equal(p.state,'prepared-not-sent');assert.equal(p.transaction.from.toLowerCase(),principal.principal.address.toLowerCase());assert.equal(p.transaction.value,'100');assert.equal(p.intentHash,digest(p.transaction));const decoded=decodeFunctionData({abi:dealAbi,data:p.transaction.data});assert.equal(decoded.functionName,'createDeal');assert.equal(decoded.args[1],p.projectHash);
 await assert.rejects(bob.call('deal_prepare',base),e=>['not_found','scope_denied'].includes(e.code));assert.equal(requests.length,1);
 await assert.rejects(owner.call('deal_prepare',{...base,input:{...base.input,to:worker}}),e=>e.code==='invalid_shape');
 const r=await owner.call('deal_prepare',{projectId,chainId:11155111,action:'run',input:{id:hash,expectedRun:3}});assert.deepEqual(decodeFunctionData({abi:dealAbi,data:r.transaction.data}).args,[hash,3]);
 await assert.rejects(owner.call('deal_prepare',{projectId,chainId:11155111,action:'run',input:{id:hash}}),e=>e.code==='invalid_shape');
 const plan=await owner.call('deal_prepare',{projectId,chainId:11155111,action:'plan',input:{salt:hash,termsHash:hash,worker,priceWei:'100',maximumRuns:4,intervalSeconds:60,deliverySeconds:3600,expiresAt:Math.floor(Date.now()/1000)+86400}});assert.equal(plan.transaction.value,'400');
});
test('audit: read delegates cannot prepare owner spending; explicit exits survive suspension',async t=>{
 const ports={context:async()=>({public:{chainId:1,contract}}),id:async()=>hash,prepare:async(c,v)=>({transaction:{chainId:1,from:v.sender,to:contract,value:String(v.value),data:'0x'}})};
 const f=await fixture(t,{dealPorts:ports}),projectId=f.project.id,a=await f.owner.call('agent_create',{projectId,name:'Reader'}),m=await f.owner.call('mandate_create',{projectId,principalId:a.id,scopes:['project.read'],expiresAt:Date.now()+60000}),key=await f.owner.call('credential_create',{mandateId:m.id});
 const input={projectId,chainId:1,action:'withdraw',input:{amountWei:'1',recipient:worker}};
 await assert.rejects(()=>f.app.service.execute('deal_prepare',input,key.token),e=>e.code==='scope_denied');
 await f.store.transaction(tx=>tx.write('project-access',projectId,{suspended:true},0));
 assert.equal((await f.owner.call('deal_prepare',input)).state,'prepared-not-sent');
 await assert.rejects(()=>f.owner.call('deal_prepare',{projectId,chainId:1,action:'fund',input:{salt:hash,termsHash:hash,worker,priceWei:'1',deliveryDue:100}}),e=>e.code==='scope_denied');
});
test('audit: optional malformed pins stay isolated; read caching never serves transaction preflight',async()=>{
 const invalid=dealPorts({CLAUS_DEAL_PINS:'{'});await assert.rejects(()=>invalid.context(1),e=>e.code==='invalid_deal_pins');
 let time=0,calls=0;const code='0x6000',arbiter='0x3000000000000000000000000000000000000003',controller='0x4000000000000000000000000000000000000004';
 const client={getChainId:async()=>{calls++;return 1;},getBlock:async()=>{calls++;return{number:1n,hash,timestamp:10n};},getBytecode:async()=>{calls++;return code;},readContract:async({functionName})=>{calls++;return{arbiter,admissionController:controller,maximumDeal:1n,maximumPrincipal:5n,fundingEnabled:true}[functionName];}};
 const ports=dealPorts({CLAUS_DEAL_PINS:JSON.stringify([{chainId:1,contract,codeHash:keccak256(code),arbiter,admissionController:controller,maximumDealWei:'1',reviewed:true}]),CLAUS_MAINNET_RPC_URL:'https://rpc.example.com'},{clientFactory:()=>client,now:()=>time});
 await Promise.all([ports.context(1),ports.context(1)]);assert.equal(calls,8);await ports.context(1);assert.equal(calls,8);await ports.context(1,{fresh:true});assert.equal(calls,12);time=1001;await ports.context(1);assert.equal(calls,16);
});
test('no deployment or browser app session can become payment authority',async t=>{
 const{owner,project,app}=await fixture(t);assert.equal((await owner.call('deal_terms',{chainId:1})).enabled,false);
 await assert.rejects(owner.call('deal_prepare',{projectId:project.id,chainId:1,action:'run',input:{id:hash,expectedRun:0}}),e=>e.code==='deals_not_enabled'&&e.status===409);
 const session=await owner.call('app_session_create',{projectId:project.id,actions:['app_records'],expiresAt:Date.now()+60000});
 await assert.rejects(app.service.execute('deal_prepare',{projectId:project.id,chainId:1,action:'withdraw',input:{amountWei:'1',recipient:worker}},session.token),e=>e.code==='scope_denied');
});
