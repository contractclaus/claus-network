import test from 'node:test';
import assert from 'node:assert/strict';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {createApplication} from '../runtime/server.mjs';
import {openStore} from '../src/storage/index.mjs';
import {render} from '../hosting/render.mjs';

test('UI files need separate publication and expire without publishing other snapshot files',async t=>{
  const store=openStore(':memory:');t.after(()=>store.close());let time=Date.now();
  const app=createApplication({store,now:()=>time,rateSalt:'test-only'.repeat(5)});
  const key=privateKeyToAccount(generatePrivateKey()),c=await app.identity.challenge({address:key.address});
  const login=await app.identity.session({challengeId:c.id,signature:await key.signMessage({message:c.message})});
  const actor=await app.identity.authenticate(login.token);
  const project=await app.identity.createProject(actor,{slug:'static-example',name:'Static example',idempotencyKey:'one'});
  await store.transaction(async tx=>{
    await tx.write('network-capabilities','collaboration',{enabled:true},0);
    await tx.write('review-pilots',project.id,{enabled:true,expiresAt:time+86400000},0);
  });
  const snapshot=await app.projects.createSnapshot(actor,project.id,{expectedProjectRevision:1,files:[
    {path:'index.html',content:'<!doctype html><title>Project</title><script>document.body.textContent="ready"</script>'},
    {path:'private.md',content:'Private notes must not be published.'}]});
  const release=await app.releases.create(actor,project.id,{snapshotId:snapshot.id,paths:['index.html']});
  await assert.rejects(app.releases.public(release.id),{code:'not_found'});
  const pub=await app.releases.publish(actor,project.id,{releaseId:release.id,published:true,expiresAt:time+120000,expectedRevision:0});
  const publicData=await app.releases.public(release.id);assert.equal(publicData.files.length,1);
  assert.equal((await app.projects.graph()).nodes.length,1,'publishing UI does not publish the project profile');
  const response=await render(new Request(release.url),{fetcher:async()=>Response.json(publicData)});
  assert.equal(response.status,200);assert.match(response.headers.get('content-security-policy'),/sandbox allow-scripts;/);
  assert.ok(!response.headers.get('content-security-policy').includes('allow-same-origin'));
  assert.match(response.headers.get('content-security-policy'),/connect-src 'none'/);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(response.headers.get('access-control-allow-credentials'),null);
  const missing=await render(new Request(release.url.replace('index.html','private.js')),{fetcher:async()=>Response.json(publicData)});
  assert.equal(missing.status,404);
  time+=121000;await assert.rejects(app.releases.public(release.id),{code:'not_found'});
  await app.releases.publish(actor,project.id,{releaseId:release.id,published:true,expiresAt:time+120000,expectedRevision:pub.revision});
  assert.equal((await app.releases.public(release.id)).contentHash,release.contentHash);
  await app.releases.publish(actor,project.id,{releaseId:release.id,published:false,expiresAt:0,expectedRevision:2});
  await assert.rejects(app.releases.public(release.id),{code:'not_found'});
});

test('isolated host cannot be used as a proxy or select non-public files',async()=>{
  let fetches=0;const fetcher=async()=>{fetches++;return new Response('{}',{status:404});};
  for(const path of ['/api/private','/r/'+'a'.repeat(64)+'/../secret.json','/r/'+'a'.repeat(64)+'/index.html?url=https://example.com']){
    assert.equal((await render(new Request('https://claus-network-sites.vercel.app'+path),{fetcher})).status,404);
  }
  assert.equal(fetches,0);
});
test('a second operator serves only its own configured API and isolated site origin',async()=>{
  const id='sha256:'+'a'.repeat(64),options={apiOrigin:'https://api.other.example',siteOrigin:'https://sites.other.example',frameOrigin:'https://other.example'};
  const response=await render(new Request(options.siteOrigin+'/r/'+id.slice(7)+'/index.html'),{...options,fetcher:async url=>{
    assert.equal(url,options.apiOrigin+'/v1/public/releases/sha256%3A'+id.slice(7));
    return Response.json({id,expiresAt:Date.now()+60000,files:[{path:'index.html',content:'independent source'}]});
  }});
  assert.equal(await response.text(),'independent source');
  assert.ok(!response.headers.get('content-security-policy').includes('claus.si'));
  await assert.rejects(render(new Request(options.siteOrigin+'/'),{...options,apiOrigin:options.siteOrigin}),/not_isolated/);
});
