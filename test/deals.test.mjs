import test from'node:test';import assert from'node:assert/strict';import {encodeFunctionData,decodeFunctionData}from'viem';import{fixture}from'./apps-fixture.mjs';import{dealAbi}from'../src/deals/index.mjs';import{digest}from'../src/shared/index.mjs';
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
test('no deployment or browser app session can become payment authority',async t=>{
 const{owner,project,app}=await fixture(t);assert.equal((await owner.call('deal_terms',{chainId:1})).enabled,false);
 await assert.rejects(owner.call('deal_prepare',{projectId:project.id,chainId:1,action:'run',input:{id:hash,expectedRun:0}}),e=>e.code==='deals_not_enabled'&&e.status===409);
 const session=await owner.call('app_session_create',{projectId:project.id,actions:['app_records'],expiresAt:Date.now()+60000});
 await assert.rejects(app.service.execute('deal_prepare',{projectId:project.id,chainId:1,action:'withdraw',input:{amountWei:'1',recipient:worker}},session.token),e=>e.code==='scope_denied');
});
