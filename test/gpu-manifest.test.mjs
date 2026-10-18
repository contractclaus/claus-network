import test from 'node:test';
import assert from 'node:assert/strict';
import {validateManifest,validateProfile,matchManifest,gpuCount} from '../src/infrastructure/manifest.mjs';
import {digest} from '../src/shared/index.mjs';
import {ROUTES,validate} from '../interfaces/contract.mjs';
const manifest={version:1,mode:'job',image:'ghcr.io/contractclaus/app@sha256:'+'a'.repeat(64),region:'EU-NL-1',cpu:16,memoryMiB:65536,gpu:'GPU A',port:null,healthPath:null,command:[],storageGiB:0,releaseHash:digest('release')};
const profile={id:'gpu',enabled:true,provider:'runpod',accountId:'own',asset:'USD',fundingAccount:'fund',permissionHash:digest('permission'),maxLeaseSeconds:3600,maxPerLease:'200000000',maxActive:10,imagePrefixes:['ghcr.io/contractclaus/'],regions:['EU-NL-1'],maxCpu:64,maxMemoryMiB:524288,maxStorageGiB:0,gpuTypes:['GPU A']};
test('old manifests and profiles retain their identity; multiple GPUs require an explicit profile',()=>{
 assert.equal(digest(validateManifest(manifest)),digest(manifest));assert.equal(digest(validateProfile(profile)),digest(profile));assert.equal(gpuCount(manifest),1);
 const multi={...manifest,gpuCount:4,minimumVramGiB:48};validateManifest(multi);
 assert.throws(()=>matchManifest(profile,multi),{code:'infrastructure_gpu_count_not_allowed'});matchManifest(validateProfile({...profile,maxGpuCount:8}),multi);
 assert.throws(()=>validateManifest({...multi,gpuCount:0}));assert.throws(()=>validateManifest({...manifest,gpu:null,gpuCount:2}));
});
test('quote and runtime-release schemas accept optional GPU requirements without making them mandatory',()=>{
 const quote=ROUTES.find(r=>r.name==='resource_quote');
 const input={projectId:'p',profileId:'gpu',manifest,leaseSeconds:3600,idempotencyKey:'q'};validate(quote.inputSchema,input);validate(quote.inputSchema,{...input,manifest:{...manifest,gpuCount:4,minimumVramGiB:48}});
 const {releaseHash,...runtime}=manifest;const release=ROUTES.find(r=>r.name==='resource_release_prepare');
 validate(release.inputSchema,{projectId:'p',buildId:digest('build'),manifest:runtime});validate(release.inputSchema,{projectId:'p',buildId:digest('build'),manifest:{...runtime,gpuCount:4}});
 validate(ROUTES.find(r=>r.name==='resource_profile_set').inputSchema,{profile:{...profile,maxGpuCount:8},expectedRevision:0});
});
