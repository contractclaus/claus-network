import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {chromium} from 'playwright-core';
import {ResearchCache} from '../src/research-cache.js';
import {operationSucceeded} from '../src/operation-result.js';
import {readLabSource} from '../src/lab-sources.js';
import {resultPage} from '../src/external/service.js';
import {observeProducts} from '../src/network-products.js';
import {browserWorkflow} from '../src/external/browser-workflow.js';
import {providerJson,ProviderFailure} from '../src/external/providers.js';
import {operatingLessons} from '../src/operating-lessons.js';
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function cacheFixture(){
 const db=new PGlite();await db.exec('CREATE TABLE claus_research_cache(id text PRIMARY KEY,result jsonb,next_at timestamptz NOT NULL,error text);CREATE TABLE claus_research_reads(id serial,kind text,created_at timestamptz);');
 const wrap=(d:any)=>({query:(s:string,p:any[])=>d.query(s,p)});
 const adapter:any={...wrap(db),transaction:(fn:any)=>db.transaction(tx=>fn(wrap(tx)))};
 let time=Date.parse('2026-10-17T06:00:00Z');return {db,cache:new ResearchCache(adapter,()=>new Date(time)),advance:()=>time+=61000};
}
test('running and blocked envelopes cannot certify completed work',()=>{
 for(const status of ['running','preparing','deploying','waiting','blocked','stopped','cancelled','canceled'])assert.equal(operationSucceeded({result:{status}}),false,status);
 assert.equal(operationSucceeded([]),false);assert.equal(operationSucceeded({status:'completed',result:{value:0}}),true);
});
test('late cache success or failure cannot overwrite a newer refresh',async()=>{
 const f=await cacheFixture();try{
  for(const failure of [false,true]){
   let finish:any,entered:any;const started=new Promise(r=>entered=r),key=String(failure);
   const old=f.cache.read('fixture',key,1000,()=>{entered();return new Promise((resolve,reject)=>finish=failure?()=>reject(Error('search_old_failure')):()=>resolve({version:'old'}));});
   await started;f.advance();await f.cache.read('fixture',key,1000,async()=>({version:'new'}));finish();await old;
   const read=await f.cache.read('fixture',key,1000,async()=>{throw Error('must reuse new value');});assert.equal(read.available,true);assert.equal(read.result.version,'new');
  }
 }finally{await f.db.close();}
});
test('false, zero and empty string stay valid cache results',async()=>{
 const f=await cacheFixture();try{for(const value of [false,0,'']){await f.cache.read('fixture',JSON.stringify(value),1000,async()=>value);const out=await f.cache.read('fixture',JSON.stringify(value),1000,async()=>{throw Error('unexpected fetch');});assert.equal(out.available,true);assert.equal(out.result,value);}}finally{await f.db.close();}
});
test('Lab clipping preserves an explicit truncation flag with its next cursor',async()=>{
 const page:any={url:'https://example.org',content:'x'.repeat(20000),totalChars:20000,truncated:false,nextOffset:null,offset:0};
 const out:any=await readLabSource(page.url,null,undefined,async()=>page);assert.equal(out.content.length,12000);assert.equal(out.nextOffset,12000);assert.equal(out.truncated,true);
});
test('paginated external receipts never split a surrogate pair',()=>{
 const value={text:'x'.repeat(23990)+'😀tail'},expected=JSON.stringify(value);let offset=0,joined='';
 do{const out:any=resultPage('receipt',value,offset);assert.equal(Buffer.from(out.content).toString('utf8'),out.content);joined+=out.content;offset=out.nextOffset;}while(offset!==null);
 assert.equal(joined,expected);
});
test('project discovery and detail reads share one total deadline',async()=>{
 const started=Date.now();
 const net:any={call:async(name:string)=>{if(name==='project_list'){await delay(70);return {items:[{id:'p_one',slug:'one'}],nextCursor:null};}return new Promise(()=>{});}};
 const out=await observeProducts(net,undefined,100,async()=>({state:'checked'}) as any);assert(Date.now()-started<150);assert(out.items);assert.equal(out.items[0].metrics.available,false);
});
async function browserFixture(t:any,failObservation=false,releaseFail=false){
 const old=process.env.BROWSERBASE_API_KEY;process.env.BROWSERBASE_API_KEY='fixture-only';t.after(()=>{if(old===undefined)delete process.env.BROWSERBASE_API_KEY;else process.env.BROWSERBASE_API_KEY=old;});
 let clicks=0,releaseCalls=0;const page:any={url:()=> 'https://example.org',title:async()=> 'fixture',setDefaultTimeout(){},goto:async()=>{},getByRole:()=>({count:async()=>1,isVisible:async()=>true,click:async()=>{clicks++;}}),locator:()=>({innerText:async()=>{if(clicks&&failObservation)throw Error('read lost');return 'page';},evaluateAll:async()=>[]})};
 const context={route:async()=>{},pages:()=>[page]},browser={contexts:()=>[context],close:async()=>{}};
 t.mock.method(chromium,'connectOverCDP',async()=>browser);
 t.mock.method(globalThis,'fetch',async(url:any)=>{if(String(url).endsWith('/sessions'))return Response.json({id:'session-original',projectId:'fixture',connectUrl:'wss://connect.browserbase.com/test'});releaseCalls++;if(releaseFail)throw Error('release response lost');return Response.json({id:'session-original',projectId:'fixture',status:'COMPLETED'});});
 const policy:any={version:1,browser:{projectId:'fixture',origins:['https://example.org'],seconds:60}};
 return {run:()=>browserWorkflow(policy,{url:'https://example.org',steps:[{action:'click',target:{role:'button',name:'Submit'}}]},'original'),clicks:()=>clicks,releases:()=>releaseCalls};
}
test('lost browser release response is not reported as a closed session',async t=>{
 const f=await browserFixture(t,false,true),out=await f.run();assert.equal(out.state,'completed');assert.equal(out.closedAfterWork,false);assert.equal((out as any).sessionRelease.state,'unknown');assert.equal(f.releases(),1);
});
test('a failed post-click observation identifies the actual step without replay',async t=>{
 const f=await browserFixture(t,true),out:any=await f.run();assert.equal(out.state,'stopped');assert.equal(out.failedStep,0);assert.equal(out.failurePhase,'observation');assert.equal(out.completedSteps,1);assert.equal(f.clicks(),1);assert.equal(out.retryWholeWorkflow,false);
});
test('response stream failures preserve read/write certainty and release the reader',async()=>{
 for(const readOnly of [true,false]){
  const response=new Response(new ReadableStream({start(c){c.error(Error('body interrupted'));}}));
  await assert.rejects(providerJson('https://example.org',{},readOnly,async()=>response),e=>e instanceof ProviderFailure&&e.confirmed===readOnly);
  assert.equal(response.body?.locked,false);
 }
});
test('distinct lessons and public lessons survive a busy recent private incident',async()=>{
 const db=new PGlite();try{
  await db.exec("CREATE TABLE claus_network_measurements(id serial,subject text,document jsonb,observed_at timestamptz DEFAULT now());CREATE TABLE claus_journal(id integer,visibility text);INSERT INTO claus_journal VALUES(1,'public'),(2,'private_network');INSERT INTO claus_network_measurements(subject,document) SELECT 'lesson:'||i,jsonb_build_object('incidentId','incident-'||i,'reason','lesson '||i,'evidence','j_1') FROM generate_series(1,6) i;INSERT INTO claus_network_measurements(subject,document) SELECT 'lesson:busy',jsonb_build_object('incidentId','busy','reason','latest '||i,'evidence','j_2') FROM generate_series(1,35) i;");
  const tag=async(parts:TemplateStringsArray,...params:any[])=>(await db.query(parts.reduce((s,p,i)=>s+(i?'$'+i:'')+p,''),params)).rows;
  const all=await operatingLessons(false,()=>tag);assert.equal(all.items.length,6);
  const pub=await operatingLessons(true,()=>tag);assert.equal(pub.items.length,6);assert(pub.items.every(i=>i.visibility==='public'));
 }finally{await db.close();}
});
