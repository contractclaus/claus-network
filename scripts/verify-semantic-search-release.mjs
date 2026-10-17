// Reproduce the model source bindings using the network's actual hash format.
// This does not approve the model or attest that an endpoint is running.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {digest} from '../src/shared/index.mjs';
import {createOciBuildPlan} from '../src/infrastructure/build-plan.mjs';
const root=new URL('../',import.meta.url);
const evidence=JSON.parse(fs.readFileSync(new URL('docs/evidence/semantic-search-release.json',root),'utf8'));
const files=evidence.files.map(({path,sha256})=>{
 const content=fs.readFileSync(new URL(path,root),'utf8');
 assert.equal(createHash('sha256').update(content).digest('hex'),sha256,path);
 return {path,content,hash:digest({path,content})};
}).sort((a,b)=>a.path.localeCompare(b.path,'en'));
const snapshot=digest(files.map(({path,hash})=>({path,hash})));
assert.equal(snapshot,evidence.snapshotId);
const plan=createOciBuildPlan({projectId:evidence.projectId,snapshotId:snapshot,dockerfile:'examples/semantic-search/Dockerfile',files});
assert.equal(plan.id,evidence.plan.id);
assert.equal(plan.sourceHash,evidence.plan.sourceHash);
assert.equal(plan.sourceBytes,evidence.plan.sourceBytes);
assert.equal(evidence.build.snapshotId,snapshot);
assert.equal(evidence.build.planId,plan.id);
assert.equal(evidence.build.sourceHash,plan.sourceHash);
assert.equal(evidence.release.buildId,evidence.build.id);
assert.equal(evidence.release.manifest.image,evidence.image);
const receipt=evidence.build.receipt;
assert(receipt && !receipt.download && !receipt.artifactAvailability,'Exact build receipt required, without temporary download credentials');
assert.equal(digest(receipt),evidence.build.artifactHash);
assert.equal(receipt.buildId,evidence.build.id);
assert.equal(receipt.projectId,evidence.projectId);
assert.equal(receipt.planId,plan.id);
assert.equal(receipt.sourceHash,plan.sourceHash);
assert.equal(receipt.imageDigest,evidence.image.split('@')[1]);
assert.equal(receipt.evidence,'compiled_only');
assert.equal(receipt.verification,false);
assert.equal(receipt.storage?.state,'verified');
assert.equal(receipt.storage.archiveHash,receipt.archiveHash);
assert.equal(receipt.storage.bytes,receipt.archiveBytes);
assert.equal(evidence.release.buildHash,evidence.build.artifactHash);
assert.equal(evidence.release.sourceHash,snapshot);

console.log(JSON.stringify({sourceBindingsVerified:true,buildReceiptVerified:true,snapshotId:snapshot,buildId:evidence.build.id,releaseId:evidence.release.id,root:fileURLToPath(root),approvalGranted:false}));
