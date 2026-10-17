import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {browserWorkflow, readonlyBrowserReport, workflowInput} from '../src/external/browser-workflow.js';
import {validProgressEvidence, validWorkEvidence} from '../src/network-operations.js';

const policy:any={version:1,browser:{projectId:'fixture',origins:['https://example.org'],seconds:60}};
const field=(value:string,attributes:Record<string,string>={},extra:any={})=>({
  tagName:'TEXTAREA',readOnly:true,value,
  getAttribute:(key:string)=>attributes[key]??null,
  labels:[{innerText:'Public report JSON'}],...extra,
});

test('completed private browser evidence supports internal assessment but stays private',()=>{
  const row={kind:'tool',summary:'external_tools',visibility:'private_network',data:{success:true,result:{actionId:'external:original',status:'completed',result:{state:'completed',completedSteps:6,sessionRelease:{state:'confirmed'}}}}};
  assert.equal(validProgressEvidence(row),true);
  assert.equal(validWorkEvidence(row,'internal'),true);
  assert.equal(validWorkEvidence(row,'public'),false);
  for(const state of ['stopped','pending','unknown','failed']) assert.equal(validWorkEvidence({...row,data:{success:true,result:{status:'completed',result:{state}}}},'internal'),false);
  assert.equal(validWorkEvidence({...row,summary:'recall'},'internal'),false);
  assert.equal(validWorkEvidence({...row,visibility:'private_club'},'internal'),false);
  assert.equal(validWorkEvidence({...row,data:{...row.data,success:false}},'internal'),false);
  assert.equal(validWorkEvidence({...row,summary:'read_operational_code',data:{success:true,result:{path:'src/example.js',revision:1}}},'internal'),true);
});

test('explicit read-only report extraction preserves bytes and rejects editable or credential fields',()=>{
  const json='{"project":"example","checks":[{"state":"ready"}]}\n';
  assert.deepEqual(readonlyBrowserReport(field(json)),{tag:'textarea',name:'Public report JSON',value:json,totalChars:json.length,truncated:false});
  for(const node of [field(json,{}, {readOnly:false}),field(json,{}, {tagName:'INPUT'}),field(json,{'aria-label':'API key'}),field(json,{id:'private_key'})]) assert.deepEqual(readonlyBrowserReport(node),{denied:true});
  assert.throws(()=>workflowInput(policy,{url:'https://example.org',steps:[{action:'read',target:{selector:'textarea'}}]}));
});

test('large report extraction marks truncation and preserves complete Unicode characters',()=>{
  const text='x'.repeat(15999)+'😀end',report=readonlyBrowserReport(field(text));
  assert.equal(report.value,'x'.repeat(15999));
  assert.equal(report.totalChars,text.length);
  assert.equal(report.truncated,true);
});

test('targeted browser read returns the observed report and closes its original session',async t=>{
  const previous=process.env.BROWSERBASE_API_KEY;
  process.env.BROWSERBASE_API_KEY='fixture-only';
  t.after(()=>{if(previous===undefined)delete process.env.BROWSERBASE_API_KEY;else process.env.BROWSERBASE_API_KEY=previous;});
  let reads=0,closed=0;
  const node=field('{"checked":true}');
  const loc={count:async()=>1,isVisible:async()=>true,evaluate:async(fn:any)=>{reads++;return fn(node);}};
  const page:any={url:()=> 'https://example.org',title:async()=> 'Report',setDefaultTimeout(){},goto:async()=>{},getByLabel:()=>loc,locator:()=>({innerText:async()=> 'Report',evaluateAll:async()=>[]})};
  t.mock.method(chromium,'connectOverCDP',async()=>({contexts:()=>[{route:async()=>{},pages:()=>[page]}],close:async()=>{}}) as any);
  t.mock.method(globalThis,'fetch',async(url:any)=>{
    if(String(url).endsWith('/sessions'))return Response.json({id:'original-session',projectId:'fixture',connectUrl:'wss://connect.browserbase.com/test'});
    closed++;return Response.json({id:'original-session',projectId:'fixture',status:'COMPLETED'});
  });
  const result:any=await browserWorkflow(policy,{url:'https://example.org',steps:[{action:'read',target:{label:'Public report JSON'}}]},'original');
  assert.equal(result.state,'completed');
  assert.equal(result.observations.at(-1).report.value,'{"checked":true}');
  assert.equal(result.completedSteps,1);
  assert.equal(result.sessionRelease.state,'confirmed');
  assert.equal(reads,1);assert.equal(closed,1);
});
