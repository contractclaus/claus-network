import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createOciBuildPlan,ociBuildArguments} from '../src/infrastructure/build-plan.mjs';
import {requireThat} from '../src/shared/index.mjs';

const exec=promisify(execFile);
const maxImageBytes=33554432;
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const buildId=process.env.CLAUS_OCI_BUILD_ID;
requireThat(buildId==='verify'||/^sha256:[a-f0-9]{64}$/.test(buildId??''),'oci_build_id_invalid');
requireThat(process.env.GITHUB_REPOSITORY==='contractclaus/claus-network'&&process.env.GITHUB_EVENT_NAME==='workflow_dispatch'&&process.env.GITHUB_RUN_ATTEMPT==='1','oci_runner_context_invalid');
const root=path.join(process.env.RUNNER_TEMP,'claus-oci'),context=path.join(root,'source'),config=path.join(root,'docker');
await fs.mkdir(root,{recursive:false});await fs.mkdir(context);await fs.mkdir(config);await fs.writeFile(path.join(config,'config.json'),'{}',{mode:0o600});
let source;
if(buildId==='verify'){
  const dir=new URL('../test/fixtures/oci/',import.meta.url),files=[];
  for(const name of ['Dockerfile','main.go','go.mod'])files.push({path:name,content:await fs.readFile(new URL(name,dir),'utf8')});
  source={buildId,plan:createOciBuildPlan({projectId:'operator-verification',snapshotId:'verification-'+process.env.GITHUB_SHA,files})};
}else{
  const response=await fetch('https://claus-network-api.vercel.app/v1/public/infrastructure/builds/'+encodeURIComponent(buildId)+'/source',{redirect:'error',signal:AbortSignal.timeout(20000)});
  requireThat(response.ok,'oci_public_source_unavailable');const text=await response.text();requireThat(Buffer.byteLength(text)<=3200000,'oci_source_too_large');source=JSON.parse(text);
}
requireThat(source.buildId===buildId,'oci_source_mismatch');
const original=source.plan,plan=createOciBuildPlan({projectId:original.projectId,snapshotId:original.snapshotId,dockerfile:original.dockerfile,files:original.source});
requireThat(plan.id===original.id&&plan.sourceHash===original.sourceHash,'oci_plan_changed');
for(const f of plan.source){const filename=path.join(context,f.path);await fs.mkdir(path.dirname(filename),{recursive:true});await fs.writeFile(filename,f.content,{flag:'wx',mode:0o600});}
const options={env:{PATH:process.env.PATH,HOME:root,DOCKER_CONFIG:config,TMPDIR:process.env.RUNNER_TEMP},maxBuffer:4000000,timeout:480000,killSignal:'SIGKILL'};
const builder='claus-oci-'+process.env.GITHUB_RUN_ID,archive=path.join(root,'image.tar'),metadataFile=path.join(root,'metadata.json');
const buildkit=JSON.parse(await fs.readFile(new URL('../config/oci-runner.json',import.meta.url),'utf8')).buildkit;
requireThat(/^moby\/buildkit@sha256:[a-f0-9]{64}$/.test(buildkit),'oci_builder_not_pinned');
try{
  await exec('docker',['buildx','create','--name',builder,'--driver','docker-container','--driver-opt','image='+buildkit],options);
  const args=ociBuildArguments(plan,{context,output:archive,metadata:metadataFile});
  args.splice(2,0,'--builder',builder,'--build-arg','SOURCE_DATE_EPOCH=0');
  await exec('docker',args,options);
  const stat=await fs.stat(archive);requireThat(stat.isFile()&&stat.size>0&&stat.size<=maxImageBytes,'oci_image_too_large');
  const metadata=JSON.parse(await fs.readFile(metadataFile,'utf8'));
  requireThat(/^sha256:[a-f0-9]{64}$/.test(metadata['containerimage.digest']??''),'oci_image_digest_missing');
  const imageDigest=metadata['containerimage.digest'];
  const {stdout}=await exec('tar',['-xOf',archive,'index.json'],{maxBuffer:131072,timeout:10000});
  const index=JSON.parse(stdout);requireThat(index.schemaVersion===2&&index.manifests.some(m=>m.digest===imageDigest),'oci_index_mismatch');
  const manifest=await exec('tar',['-xOf',archive,'blobs/sha256/'+imageDigest.slice(7)],{encoding:'buffer',maxBuffer:1000000,timeout:10000});
  requireThat(hash(manifest.stdout)===imageDigest,'oci_manifest_mismatch');
  const sum=createHash('sha256');for await(const chunk of createReadStream(archive))sum.update(chunk);
  const receipt={version:1,buildId,projectId:plan.projectId,planId:plan.id,sourceHash:plan.sourceHash,imageDigest,archiveHash:'sha256:'+sum.digest('hex'),archiveBytes:stat.size,runId:process.env.GITHUB_RUN_ID,runnerSha:process.env.GITHUB_SHA,evidence:'compiled_only',verification:buildId==='verify'};
  await fs.writeFile(path.join(root,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
  console.log('OCI compilation complete: '+imageDigest);
}catch(error){
  // Do not print arbitrary build stdout as GitHub workflow commands.
  const log=typeof error.stderr==='string'?error.stderr.slice(-32000):String(error.code??error.message);
  await fs.writeFile(path.join(root,'failure.txt'),log);console.error('OCI compilation failed; see the bounded build log.');process.exitCode=1;
}finally{
  await exec('docker',['buildx','rm','--force',builder],{...options,timeout:30000}).catch(()=>{});
  await fs.rm(context,{recursive:true,force:true});await fs.rm(config,{recursive:true,force:true});
}
