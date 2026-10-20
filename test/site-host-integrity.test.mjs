import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {digest} from '../src/shared/index.mjs';
import {render} from '../hosting/render.mjs';
const file={path:'index.html',content:'<!doctype html><h1>Published source</h1>'};file.hash=digest(file);
const release={id:'sha256:'+'1'.repeat(64),expiresAt:null,paths:['index.html'],file};
const request=()=>new Request('https://claus-network-sites.vercel.app/r/'+release.id.slice(7)+'/index.html');
test('raw source bytes and presentation are separate representations',async()=>{
 const options={fetcher:async()=>Response.json(release)};
 assert.equal(await(await render(request(),options)).text(),file.content);
 assert.match(await(await render(request(),{...options,navigation:true})).text(),/claus-site-ready/);
 const config=JSON.parse(fs.readFileSync(new URL('../hosting/vercel.json',import.meta.url)));
 assert(config.routes.some(r=>r.src==='/view/(.*)'&&r.dest.includes('__claus_view')));
 assert(config.routes.some(r=>r.src==='/r/(.*)'&&r.dest.includes('__claus_route')));
});
test('altered and withdrawn source cannot be returned as a published page',async()=>{
 const corrupt={...release,file:{...file,content:file.content+' altered'}};
 assert.equal((await render(request(),{fetcher:async()=>Response.json(corrupt)})).status,503);
 assert.equal((await render(request(),{fetcher:async()=>new Response(null,{status:404})})).status,404);
});
test('oversized chunked replies stop reading without trusting Content-Length',async()=>{
 let cancelled=false;
 const body=new ReadableStream({pull(c){c.enqueue(new Uint8Array(1100000));},cancel(){cancelled=true;}});
 assert.equal((await render(request(),{fetcher:async()=>new Response(body)})).status,503);
 assert(cancelled);
});
