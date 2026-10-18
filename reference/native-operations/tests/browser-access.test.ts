import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {browserOrigin,publicBrowserOrigin} from '../src/external/browser-targets.js';
import {browserAccess,browserPolicyForWork} from '../src/external/browser-access.js';
import {ownedBrowserSession,readBrowserDownload,signBrowserDownload} from '../src/external/browser-downloads.js';

test('task origin changes retain history, reconcile duplicates and revoke with the work',async()=>{
 const db=new PGlite();
 await db.exec("CREATE TABLE claus_actions(id text PRIMARY KEY,kind text,input_hash text,status text,input jsonb,result jsonb,visibility text,completed_at timestamptz); CREATE TABLE claus_network_work(id text PRIMARY KEY,status text); INSERT INTO claus_network_work VALUES('nw_real_work','working')");
 const query:any=(strings:TemplateStringsArray,...values:any[])=>{
  const text=strings.reduce((s,v,i)=>s+(i?'$'+i:'')+v,'');
  return {text,values,then:(resolve:any,reject:any)=>db.query(text,values).then(r=>r.rows).then(resolve,reject)};
 };
 query.transaction=(queries:any[])=>db.transaction(async tx=>{const out=[];for(const q of queries)out.push((await tx.query(q.text,q.values)).rows);return out;});
 const input={workId:'nw_real_work',origin:'https://provider.example',enabled:true,expectedRevision:0,purpose:'Use the provider required by this work',expiresAt:null};
 const call=(id:string,v:any,p='claus')=>browserAccess(id,'browser_origin_set',v,p,query,Date.now(),async raw=>raw);
 try{
  const first=await call('grant-a',input);assert.equal(first.revision,1);
  assert.deepEqual(await call('grant-a',input),first);
  await assert.rejects(call('guest-a',input,'foreign-worker'),/owner_required/);
  await assert.rejects(call('stale-a',input),/revision_or_work_changed/);
  const base:any={version:1,browser:{projectId:'fixture',seconds:60,origins:['https://claus.si']}};
  assert.deepEqual((await browserPolicyForWork(base,input.workId,'claus',query)).browser!.origins,['https://claus.si',input.origin]);
  await call('grant-b',{...input,enabled:false,expectedRevision:1});
  assert.deepEqual((await browserPolicyForWork(base,input.workId,'claus',query)).browser!.origins,['https://claus.si']);
  await call('grant-c',{...input,expectedRevision:2});
  await db.exec("UPDATE claus_network_work SET status='completed'");
  await assert.rejects(browserPolicyForWork(base,input.workId,'claus',query),/work_not_active/);
  const listed=await browserAccess('read','browser_origins',{workId:input.workId},'claus',query);
  assert.equal(listed.items[0].revision,3);assert.equal(listed.items[0].active,false);
  assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM claus_actions')).rows[0].n,3);
 }finally{await db.close();}
});

test('task origins reject non-public addresses and origin-wide URL ambiguity',async()=>{
 for(const raw of ['http://example.org','https://localhost','https://127.0.0.1','https://example.org/path','https://u:p@example.org','https://example.org:8443'])assert.throws(()=>browserOrigin(raw));
 await assert.rejects(publicBrowserOrigin('https://example.org',async()=>[{address:'10.0.0.1'}]),/public_address_required/);
 assert.equal(await publicBrowserOrigin('https://example.org',async()=>[{address:'93.184.216.34'}]),'https://example.org');
});

test('download grants are short-lived and tamper-evident; a session ID alone never owns a download',async()=>{
 const key='fixture-only-key-'.repeat(4),now=2000000000000;
 const value={version:1,id:'download_123',sessionId:'session_123',principal:'claus',size:42,checksum:'a'.repeat(64),exp:now+300000};
 const token=signBrowserDownload(value,key);assert.deepEqual(readBrowserDownload(token,key,now),value);
 assert.throws(()=>readBrowserDownload(token,key,now+300001));
 assert.throws(()=>readBrowserDownload(token.slice(0,20)+'a'+token.slice(21),key,now));
 await assert.rejects(ownedBrowserSession('session_123','claus',async()=>[]),/not_owned/);
});
