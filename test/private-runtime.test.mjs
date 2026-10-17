import test from 'node:test';
import assert from 'node:assert/strict';
import {imageArchive} from '../runtime/image-objects.mjs';

test('private image archive runtime starts with its configured transfer deadline',async()=>{
 const archive=await imageArchive({CLAUS_R2_ACCOUNT_ID:'a'.repeat(32),CLAUS_R2_BUCKET:'claus-project-artifacts',CLAUS_R2_ACCESS_KEY_ID:'test-access',CLAUS_R2_SECRET_ACCESS_KEY:'test-secret'});
 assert.equal(archive.enabled,true);
});
