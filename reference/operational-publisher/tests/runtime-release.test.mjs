import test from 'node:test';import assert from 'node:assert/strict';
import {runtimeReleaseApproved} from '../src/infrastructure/release.mjs';import {digest} from '../src/infrastructure/broker.mjs';
test('fixed verifier binds project, complete manifest and decision; cannot follow redirects',async()=>{
 const work={projectId:'project',manifest:{image:'registry/a@'+digest('image'),command:['node','app.js'],releaseHash:digest('release')}};
 const result={approved:true,releaseId:work.manifest.releaseHash,projectId:work.projectId,image:work.manifest.image,manifestHash:digest(work.manifest),reviewHash:digest('review'),decisionHash:digest('decision')};
 let calls=0;const request=async(url,init)=>{calls++;assert(url.startsWith('https://claus-network-api.vercel.app/v1/public/infrastructure/releases/'));assert.equal(init.redirect,'error');return Response.json({result});};
 assert(await runtimeReleaseApproved(work,{request}));assert(!await runtimeReleaseApproved({...work,manifest:{...work.manifest,command:['steal']}},{request}));assert(!await runtimeReleaseApproved({...work,projectId:'other'},{request}));
 result.approved=false;assert(!await runtimeReleaseApproved(work,{request}));assert.equal(calls,4);
 await assert.rejects(runtimeReleaseApproved(work,{request:async()=>new Response('',{status:503})}),/release_unavailable/);
});
