import test from 'node:test';
import assert from 'node:assert/strict';
import {dnsBody,dnsName,dnsMatches,dnsView} from '../src/website-admin/dns.mjs';
import {validateWebsitePlan} from '../src/website-admin/service.mjs';
const plan={version:1,kind:'dns',operation:'set',reason:'Own service configuration',name:'_dmarc.claus.si',type:'TXT',content:'v=DMARC1; p=none',ttl:300};
test('DNS service names work without expanding hosting or zone authority',()=>{
 for(const name of ['_dmarc.claus.si','selector._domainkey.claus.si','_acme-challenge.claus.si','*.apps.claus.si'])validateWebsitePlan({...plan,name});
 assert.equal(dnsName('_DMARC.CLAUS.SI.'),'_dmarc.claus.si');
 for(const name of ['claus.si.evil.test','evilclaus.si','foo.*.claus.si','../claus.si','x'.repeat(64)+'.claus.si'])assert.throws(()=>dnsBody({...plan,name}));
 assert.throws(()=>validateWebsitePlan({...plan,kind:'domain',name:'_dmarc.claus.si'}));
});
test('MX reconciliation includes priority and structured service records retain all fields',()=>{
 const mx={...plan,name:'claus.si',type:'MX',content:'mail.example.com',priority:10};
 const record=dnsView({...dnsBody(mx),id:'a'.repeat(32)});
 assert(dnsMatches(mx,record));assert(!dnsMatches({...mx,priority:20},record));
 assert.throws(()=>dnsBody({...mx,priority:undefined}));
 const cases=[['CAA',{flags:0,tag:'issue',value:'letsencrypt.org'}],['SRV',{priority:10,weight:5,port:443,target:'service.example.com'}],['HTTPS',{priority:1,target:'.',value:'alpn="h2"'}],['SVCB',{priority:1,target:'service.example.com',value:''}]];
 for(const [type,data]of cases){const p={...plan,type,content:undefined,data};const body=dnsBody(p);assert.deepEqual(body.data,data);assert(dnsMatches(p,dnsView({...body,id:'b'.repeat(32)})));}
 const a={...plan,name:'app.claus.si',type:'A',content:'1.1.1.1',proxied:true};assert.equal(dnsBody(a).ttl,1);
 assert.throws(()=>dnsBody({...plan,proxied:true}));
});
