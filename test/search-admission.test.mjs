import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generateKeyPairSync, verify} from 'node:crypto';
import {openStore} from '../src/storage/index.mjs';
import {createSearchAdmission,ADMISSION_DOMAIN,SEARCH_SERVICE} from '../src/discovery/admission.mjs';
import {createHttp} from '../interfaces/http.mjs';
import {createService} from '../interfaces/service.mjs';

function fixture(t) {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'claus-admission-'));
 const store=openStore(path.join(directory,'state.sqlite'));
 t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});
 const {privateKey,publicKey}=generateKeyPairSync('ed25519');
 let now=1700000000000,revoked=false;
 const identity={
   authorize:async(actor,scope,{projectId})=>{assert.equal(scope,'service.call');if(revoked||actor==='denied'||projectId==='other')throw Object.assign(Error('denied'),{code:'scope_denied'});},
   credential:async actor=>({kind:'owner',principalId:actor==='second-key'?'owner':actor}),
   authenticate:async token=>{if(token!=='cln_'+'a'.repeat(43))throw Object.assign(Error('unauthenticated'),{code:'unauthenticated'});return 'owner';}
 };
 const admission=createSearchAdmission({store,identity,now:()=>now,signingKey:privateKey.export({format:'pem',type:'pkcs8'})});
 return {admission,identity,publicKey,setTime:v=>{now=v;},revoke:()=>{revoked=true;}};
}
const input={projectId:'project',path:'/v1/search',bodyHash:'a'.repeat(64)};
test('ticket binds verified principal, service, body and short expiry; no arbitrary signing',async t=>{
 const f=fixture(t),r=await f.admission.issue('owner',input),[p,s]=r.ticket.split('.');
 const raw=Buffer.from(p,'base64url'),c=JSON.parse(raw);
 assert(verify(null,Buffer.concat([Buffer.from(ADMISSION_DOMAIN),raw]),f.publicKey,Buffer.from(s,'base64url')));
 assert.equal(c.sub,'owner');assert.equal(c.aud,SEARCH_SERVICE);assert.equal(c.bodyHash,input.bodyHash);assert.equal(c.path,input.path);assert.equal(c.exp-c.iat,20000);
 await assert.rejects(f.admission.issue('denied',input),{code:'scope_denied'});
 await assert.rejects(f.admission.issue('owner',{...input,projectId:'other'}),{code:'scope_denied'});
 await assert.rejects(f.admission.issue('owner',{...input,path:'https://attacker'}),{code:'invalid_input'});
 f.revoke();await assert.rejects(f.admission.issue('owner',input),{code:'scope_denied'});
});
test('keys and projects share principal capacity; other principals and refill continue',async t=>{
 const f=fixture(t);
 for(let i=0;i<120;i++)await f.admission.issue(i%2?'second-key':'owner',{...input,projectId:i%2?'project2':'project'});
 await assert.rejects(f.admission.issue('second-key',input),{code:'rate_limited'});
 await f.admission.issue('another-owner',input);
 f.setTime(1700000000500);await f.admission.issue('owner',input);
 f.setTime(1700000000501);await f.admission.issue('another-owner',input);
});
test('HTTP route requires real bearer authentication and validates request fields',async t=>{
 const f=fixture(t),http=createHttp({service:createService({identity:f.identity,searchAdmission:f.admission}),origin:'https://claus-network-api.vercel.app'});
 const url='https://claus-network-api.vercel.app/v1/projects/project/search-admission';
 const request=(body,token)=>new Request(url,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
 const body={path:input.path,bodyHash:input.bodyHash};
 assert.equal((await http(request(body))).status,401);
 assert.equal((await http(request({...body,sub:'spoofed'},'cln_'+'a'.repeat(43)))).status,400);
 const r=await http(request(body,'cln_'+'a'.repeat(43)));assert.equal(r.status,200);assert((await r.json()).ticket);
});
