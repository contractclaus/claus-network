import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {withSiteNavigation} from '../hosting/navigation.mjs';import {render} from '../hosting/render.mjs';import {digest} from '../src/shared/index.mjs';
const releaseId='sha256:'+'a'.repeat(64),frameOrigin='https://claus.si';
function fixture(){
 const events={},timers=new Map(),sent=[];let index=0;class Element{closest(){return this;}hasAttribute(){return false;}}
 const parent={postMessage:(...args)=>sent.push(args)},win={};
 const html=withSiteNavigation('<!doctype html><body>Site</body>',{releaseId,paths:['index.html','page.html'],frameOrigin});
 vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],{parent,window:win,Element,URL,Set,location:{origin:'https://claus-network-sites.vercel.app',pathname:'/view/'+releaseId.slice(7)+'/index.html',href:'https://claus-network-sites.vercel.app/view/'+releaseId.slice(7)+'/index.html'},setTimeout:fn=>{timers.set(++index,fn);return index;},clearTimeout:n=>timers.delete(n),addEventListener:(name,fn)=>events[name]=fn,document:{addEventListener:(name,fn)=>events[name]=fn}});
 return {events,timers,sent,parent,Element};
}
test('readiness retries until the exact host acknowledgment and remains bounded',()=>{
 const f=fixture();assert.equal(f.sent.length,1);assert.equal(f.timers.size,1);
 const next=[...f.timers][0];f.timers.delete(next[0]);next[1]();assert.equal(f.sent.length,2);
 f.events.message({source:f.parent,origin:'https://wrong.example',data:{type:'claus-site-host-ready',releaseId}});assert.equal(f.timers.size,1);
 f.events.message({source:f.parent,origin:frameOrigin,data:{type:'claus-site-host-ready',releaseId}});assert.equal(f.timers.size,0);
 const g=fixture();while(g.timers.size){const [id,fn]=[...g.timers][0];g.timers.delete(id);fn();}assert.equal(g.sent.length,40);
});
test('only a real user click sends external HTTP links to an isolated new tab',()=>{
 const f=fixture(),link=new f.Element();link.href='https://x.com/example';link.target='';
 const event={isTrusted:false,defaultPrevented:false,button:0,target:link};f.events.click(event);assert.equal(link.target,'');
 f.events.click({...event,isTrusted:true});assert.equal(link.target,'_blank');assert.equal(link.rel,'noopener noreferrer');
 const sent=f.sent.length;link.href='javascript:alert(1)';link.target='';f.events.click({...event,isTrusted:true});assert.equal(link.target,'');assert.equal(f.sent.length,sent);
});
test('presentation allows isolated new tabs; immutable raw source and other sandbox restrictions survive',async()=>{
 const content='<!doctype html><a href="https://x.com/example">Outside</a>',file={path:'index.html',content};file.hash=digest(file);
 const fetcher=async()=>Response.json({id:releaseId,expiresAt:null,file,paths:['index.html']});const req=new Request('https://claus-network-sites.vercel.app/r/'+releaseId.slice(7)+'/index.html');
 const raw=await render(req,{fetcher}),view=await render(req,{fetcher,navigation:true});assert.equal(raw.status,200);assert.equal(await raw.text(),content);
 assert(!raw.headers.get('content-security-policy').includes('allow-popups'));const csp=view.headers.get('content-security-policy');assert(csp.includes('allow-popups allow-popups-to-escape-sandbox'));assert(!csp.includes('allow-same-origin'));assert(!csp.includes('allow-top-navigation'));assert(csp.includes("connect-src 'none'"));assert(csp.includes("frame-src 'none'"));assert.equal(view.headers.get('x-claus-source-sha256'),raw.headers.get('x-claus-source-sha256'));
});
