import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {gzipSync,deflateSync,brotliCompressSync} from 'node:zlib';
import {PGlite} from '@electric-sql/pglite';
import {publicReader} from '../src/research-transport.js';
import {publicImageData,sourceText} from '../src/research.js';
import {searchWeb} from '../src/web-search.js';
import {externalAccessState} from '../src/external/access-state.js';
import {externalHealth} from '../src/external/health.js';
import {readNetworkIncidents} from '../src/network-incidents.js';
import {operatingAssessment} from '../src/operating-assessment.js';
const options={limit:1000,timeoutMs:1000,contentType:()=> 'text/plain'};
function fixture(replies:any[]){
 let calls=0;const signals:AbortSignal[]=[],bodies:any[]=[];
 const request=(_url:any,opts:any,callback:any)=>{
  signals.push(opts.signal);const q:any=new EventEmitter();q.end=()=>{
   const reply=replies[calls++];
   const body:any=reply.stall?new Readable({read(){}}):Readable.from([reply.bytes??Buffer.from('ok')]);
   body.statusCode=reply.status??200;body.headers=reply.headers??{};body.complete=reply.complete??true;bodies.push(body);
   opts.lookup('public',{},(_e:any,address:string)=>assert.equal(address,'93.184.216.34'));
   queueMicrotask(()=>callback(body));
  };return q;
 };
 return {reader:publicReader({resolve:async()=>[{address:'93.184.216.34'}],request}),signals,bodies,count:()=>calls};
}
test('one deadline ends stalled DNS without opening a socket',async()=>{
 let calls=0;const reader=publicReader({resolve:()=>new Promise(()=>{}),request:()=>calls++});
 await assert.rejects(reader('https://example.org',{...options,timeoutMs:20}),/source_timeout/);assert.equal(calls,0);
});
test('redirects share a deadline, pin DNS, and reject a private destination',async()=>{
 const f=fixture([{status:302,headers:{location:'/next'}},{stall:true}]);
 await assert.rejects(f.reader('https://example.org', {...options,timeoutMs:30}),/source_timeout/);
 assert.equal(f.count(),2);assert.equal(f.signals[0],f.signals[1]);assert(f.bodies.every(b=>b.destroyed));
 let sockets=0;const reader=publicReader({resolve:async()=>[{address:'127.0.0.1'}],request:()=>sockets++});
 await assert.rejects(reader('https://example.org',options),/private_address/);assert.equal(sockets,0);
});
test('compressed responses decode within both byte ceilings',async()=>{
 const value=Buffer.from('useful public documentation '.repeat(10));
 for(const [encoding,compress] of [['gzip',gzipSync],['deflate',deflateSync],['br',brotliCompressSync]] as const){
  const bytes=compress(value),f=fixture([{bytes,headers:{'content-encoding':encoding,'content-length':String(bytes.length)}}]);
  assert.deepEqual((await f.reader('https://example.org',options)).bytes,value);
 }
 const f=fixture([{bytes:gzipSync(Buffer.alloc(5000,65)),headers:{'content-encoding':'gzip'}}]);
 await assert.rejects(f.reader('https://example.org',options),/source_too_large/);assert(f.bodies[0].destroyed);
});
test('truncated, invalid compressed and oversized responses never become source evidence',async()=>{
 for(const reply of [{complete:false},{headers:{'content-length':'50'}},{bytes:Buffer.from('not gzip'),headers:{'content-encoding':'gzip'}},{bytes:Buffer.alloc(1001)}]){
  const f=fixture([reply]);await assert.rejects(f.reader('https://example.org',options));assert(f.bodies[0].destroyed);
 }
});
test('image bytes must match the reported format',()=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
 assert(publicImageData(png,'image/png').startsWith('data:image/png;'));
 assert.throws(()=>publicImageData(png,'image/jpeg'));assert.throws(()=>publicImageData(Buffer.from('<html>sign in</html>'),'image/png'));
});
test('HTML entities decode once in text and destinations, with valid Unicode',()=>{
 const result=sourceText('<p>&amp;lt; &#xD800; &#128512;</p><a href="/docs?q=&amp;lt;">Docs</a>','text/html','https://example.org');
 assert(result.includes('&lt; � 😀'));assert(result.includes('q=&lt;'));assert(!result.includes('q=<'));assert.equal(Buffer.from(result).toString('utf8'),result);
 assert.equal(sourceText('a < b','text/plain'),'a < b');
});
test('search keeps relevance order after a source fails',async()=>{
 const cache:any={now:()=>new Date(),read:async(_k:any,_q:any,_t:any,load:any)=>({result:await load()})};
 const out=await searchWeb({query:'example'},cache,async()=>['https://z.org/','https://b.org/','https://a.org/'],true,async url=>{if(url==='https://b.org/')throw Error('offline');return {url,content:'source',observedAt:'now'} as any;});
 assert.deepEqual(out.result.results.map((r:any)=>r.url),['https://z.org/','https://a.org/']);
});
test('partial inventory cannot select an account; fixed grants and dedicated GitHub remain visible',()=>{
 const config={composio:{readToolkits:['mail'],grantedToolkits:['calendar']},github:{configured:true}};
 const partial=externalAccessState(config,{items:[{id:'one',toolkit:'mail',status:'ACTIVE'}],nextCursor:'more'});
 assert.equal(partial.tools[0].state,'incomplete_inventory');assert.equal(partial.tools[0].route,null);assert.equal(partial.accountsComplete,false);
 assert.equal(partial.tools.find(t=>t.toolkit==='github')?.state,'dedicated_access');assert(partial.tools.some(t=>t.toolkit==='calendar'));
 const complete=externalAccessState(config,{items:[{id:'one',toolkit:'mail',status:'ACTIVE'},{id:'two',toolkit:'mail',status:'ACTIVE'}]});
 assert.equal(complete.tools[0].state,'selection_required');assert.equal(complete.tools[0].route,null);
});
test('an old unresolved action stays visible after more than 200 completed calls',async()=>{
 const db=new PGlite();try{
  await db.exec("CREATE TABLE claus_actions(id text,status text,input jsonb,created_at timestamptz,kind text); INSERT INTO claus_actions VALUES('original-unknown','uncertain','{}',now()-interval '2 days','external_tools'); INSERT INTO claus_actions SELECT 'done-'||i,'completed','{}',now(),'external_tools' FROM generate_series(1,210) i;");
  const tag=async(parts:TemplateStringsArray,...params:any[])=>(await db.query(parts.reduce((s,p,i)=>s+(i?'$'+i:'')+p,''),params)).rows;
  const out=await externalHealth({database:()=>tag});assert.equal(out.unresolved[0].id,'original-unknown');assert.deepEqual(out.unresolvedCoverage,{total:1,returned:1,complete:true});
 }finally{await db.close();}
});
test('older open incidents outrank a long recovered history',async()=>{
 const db=new PGlite();try{
  const tag=async(parts:TemplateStringsArray,...params:any[])=>(await db.query(parts.reduce((s,p,i)=>s+(i?'$'+i:'')+p,''),params)).rows;
  await readNetworkIncidents(()=>tag);
  await db.exec("INSERT INTO claus_network_incidents(id,source,state,first_observed_at,last_observed_at) VALUES('still-open','worker','open',now()-interval '2 days',now()-interval '2 days'); INSERT INTO claus_network_incidents(id,source,state,first_observed_at,last_observed_at) SELECT 'recovered-'||i,'worker','recovered',now(),now() FROM generate_series(1,20) i;");
  const result=await readNetworkIncidents(()=>tag);assert.equal(result[0].id,'still-open');assert.equal(result.length,12);assert.equal((await readNetworkIncidents(()=>tag,'recovered-20'))[0].id,'recovered-20');
 }finally{await db.close();}
});
const now=1780000000000,resource=(patch:any={})=>({state:'available',complete:true,capital:{state:'active',availableMicroUsdc:'100000000',cashReserveMicroUsdc:'10000000'},onchain:{state:'available',usdcMicro:'20000000'},budget:{heldMicroUsdc:'0',settledMicroUsdc:'10000'},...patch});
test('cost history distinguishes no observations, real zero cost, and counter corrections',()=>{
 assert.equal(operatingAssessment(resource(),[],now).forecastReady,false);
 const baseline={observedAt:now-6*3600000,settledMicroUsdc:'10000'};
 const zero=operatingAssessment(resource(),[baseline],now);assert.equal(zero.forecastReady,true);assert.equal(zero.observedDailyCostMicroUsdc,'0');assert.equal(zero.cashRunwayDaysBeforeOtherCommitments,null);
 const reset=operatingAssessment(resource(),[baseline,{observedAt:now-3600000,settledMicroUsdc:'12000'}],now);assert.equal(reset.forecastReady,false);assert.equal(reset.forecastReason,'settled_counter_decreased');
 const changed=resource();(changed.capital as any).policyHash='new';assert.equal(operatingAssessment(changed,[baseline],now).forecastReady,false);
});
test('cash shortage wins over a larger authorization; positive costs do not round to zero',()=>{
 const r=resource({onchain:{state:'available',usdcMicro:'12000000'}});
 assert.equal(operatingAssessment(r,[],now).state,'low');assert.equal(operatingAssessment(r,[],now).effectiveHeadroomMicroUsdc,'2000000');
 assert.equal(operatingAssessment(resource({onchain:{state:'available',usdcMicro:'1'}}),[],now).state,'exhausted');
 assert.equal(operatingAssessment(resource(),[{observedAt:now-7*86400000,settledMicroUsdc:'9999'}],now).observedDailyCostMicroUsdc,'1');
 assert.equal(operatingAssessment({...r,complete:false},[],now).state,'unknown');
});
