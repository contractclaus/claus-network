import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/storage/index.mjs';
import {createReviewAdmission} from '../src/review-flow/admission.mjs';

test('continuing sponsorship keeps its financial usage and can still be disabled',async t=>{
 const store=openStore(':memory:');t.after(()=>store.close());let now=1800000000000;
 const admission=createReviewAdmission({store,networkOwner:async(_reader,actor)=>assert.equal(actor,'owner'),now:()=>now});
 const config={enabled:true,expiresAt:null,maximumPerReview:'5',maximumLifetime:'8',perOwnerDay:2,perProjectDay:2,globalDay:8,activeGlobal:2};
 await store.transaction(tx=>tx.write('projects','p',{ownerId:'owner'},0));
 await admission.publish('owner',{version:'continuous',config});
 await admission.activate('owner',{version:'continuous',expectedGeneration:0});
 now+=365*86400000;
 assert.equal((await admission.eligible(store,'p')).expiresAt,null);
 await store.transaction(tx=>admission.reserve(tx,'p','5',config,'first'));
 await assert.rejects(store.transaction(tx=>admission.reserve(tx,'p','5',config,'second')),{code:'sponsor_exhausted'});
 await admission.publish('owner',{version:'disabled',config:{...config,enabled:false}});
 await admission.activate('owner',{version:'disabled',expectedGeneration:1});
 await assert.rejects(admission.eligible(store,'p'),{code:'sponsor_not_enabled'});
 assert.equal((await admission.get('owner')).committedMaximum,'5');
});
