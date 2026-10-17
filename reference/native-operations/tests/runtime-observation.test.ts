import test from 'node:test';
import assert from 'node:assert/strict';
import {operationSucceeded} from '../src/operation-result.js';
import {toolOutcome} from '../src/context.js';
import {validWorkEvidence} from '../src/network-operations.js';

function observed(overrides:any={}) {
 return {operation:'resource_status',observedAt:'2026-10-17T13:09:54.964Z',result:{
  id:'sha256:'+'a'.repeat(64),projectId:'prj_fixture',providerResourceId:'server-original',
  state:'running',desired:'running',terminal:false,error:null,renewalPending:false,
  requiresReconciliation:false,cost:{state:'reserved',actual:null,maximum:'796584'},...overrides
 }};
}
test('a confirmed running-resource read is successful observation, with cost still unresolved',()=>{
 const result=observed();
 assert.equal(operationSucceeded(result),true);
 assert.equal(toolOutcome(result).success,true);
 assert.equal(result.result.terminal,false);
 assert.equal(result.result.cost.actual,null);
});
test('pending actions and ambiguous resource states are not completed receipts',()=>{
 for(const operation of ['resource_request','resource_renew','resource_release_prepare',undefined])
  assert.equal(operationSucceeded({...observed(),operation}),false,String(operation));
 for(const state of ['preparing','deploying','waiting','unknown','failed','stopped','running'])
  assert.equal(operationSucceeded({result:{state}}),false,state);
 for(const patch of [{requiresReconciliation:true},{renewalPending:true},{error:'provider_unknown'},
  {desired:'stopped'},{providerResourceId:null},{id:'invalid'},{state:'unknown'}])
  assert.equal(operationSucceeded(observed(patch)),false,JSON.stringify(patch));
});
test('an observation requires a dated complete envelope and preserves outer failures',()=>{
 for(const patch of [{observedAt:null},{observedAt:'invalid'},{success:false},{error:'timeout'},{status:'pending'}])
  assert.equal(operationSucceeded({...observed(),...patch}),false,JSON.stringify(patch));
 assert.equal(operationSucceeded({result:observed()}),false);
});
test('runtime observations stay private and historical negative receipts are retained',()=>{
 const row={kind:'tool',summary:'build_network',visibility:'private_network',data:{success:true,result:observed()}};
 assert.equal(validWorkEvidence(row,'internal'),true);
 assert.equal(validWorkEvidence(row,'public'),false);
 assert.equal(validWorkEvidence({...row,data:{...row.data,success:false}},'internal'),false);
});
