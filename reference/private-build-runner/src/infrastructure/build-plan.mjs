import {canonical,copy,digest,requireThat,text} from '../shared/index.mjs';

// This plan binds a complete source snapshot to a build; it is not a build or
// review receipt. Only the protected publisher can admit the resulting digest.
export function createOciBuildPlan({projectId,snapshotId,files,dockerfile='Dockerfile'}){
 text(projectId);text(snapshotId);
 requireThat(Array.isArray(files)&&files.length>0&&files.length<=256,'oci_files_invalid');
 const seen=new Set();let bytes=0;
 const source=files.map(f=>{
  requireThat(f&&typeof f.path==='string'&&f.path.length<=200&&/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(f.path)&&f.path.split('/').every(s=>s!=='.'&&s!=='..'&&s!=='.git')&&!seen.has(f.path)&&typeof f.content==='string','oci_path_invalid');
  requireThat(!/(^|\/)\.env($|\.)|(^|\/)(?:id_rsa|id_ed25519|credentials|\.npmrc|\.netrc)$/.test(f.path),'oci_private_file');
  seen.add(f.path);bytes+=Buffer.byteLength(f.content);return {path:f.path,content:f.content};
 }).sort((a,b)=>a.path.localeCompare(b.path));
 requireThat(bytes<=3000000&&seen.has(dockerfile),'oci_context_invalid');
 const contents=source.find(f=>f.path===dockerfile).content;
 requireThat(!contents.includes('\r')&&!/^#\s*escape=/mi.test(contents),'oci_dockerfile_unsupported');
 const instructions=contents.replace(/\\\n/g,' ').split('\n').map(l=>l.trim()).filter(l=>l&&!l.startsWith('#'));
 const stages=new Set();let bases=0;
 for(const line of instructions){
  if(/^FROM\s/i.test(line)){
   const m=/^FROM\s+(\S+)(?:\s+AS\s+([A-Za-z0-9_-]+))?\s*$/i.exec(line);requireThat(m,'oci_from_invalid');
   requireThat(m[1]==='scratch'||stages.has(m[1].toLowerCase())||/^[a-z0-9.-]+\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(m[1]),'oci_base_digest_required');
   bases++;if(m[2])stages.add(m[2].toLowerCase());
  }
 }
 requireThat(bases>0,'oci_base_missing');
 const syntax=/^#\s*syntax=(\S+)\s*$/mi.exec(contents);requireThat(!syntax||/@sha256:[a-f0-9]{64}$/.test(syntax[1]),'oci_frontend_digest_required');
 for(const f of source.filter(f=>/(^|\/)package\.json$/.test(f.path))){
  const dir=f.path.slice(0,-'package.json'.length);requireThat(['package-lock.json','pnpm-lock.yaml','yarn.lock','bun.lock'].some(lock=>seen.has(dir+lock)),'oci_package_lock_required');
 }
 const body={version:1,projectId,snapshotId,dockerfile,platform:'linux/amd64',sourceHash:digest(source),sourceBytes:bytes,
  files:source.map(f=>({path:f.path,hash:digest(f.content),bytes:Buffer.byteLength(f.content)}))};
 return {...body,id:digest(body),source:copy(source),evidence:'source_plan_only',dependencyReproducibility:'requires_review_of_network_install_steps'};
}

export function ociBuildArguments(plan,{context,output,metadata}){
 requireThat(plan?.version===1&&plan.platform==='linux/amd64'&&plan.sourceHash===digest(plan.source),'oci_plan_changed');
 const {id,source,evidence,dependencyReproducibility,...body}=plan;requireThat(id===digest(body),'oci_plan_changed');
 for(const path of [context,output,metadata])requireThat(typeof path==='string'&&path.startsWith('/')&&!path.includes('\0'),'oci_output_path_invalid');
 return ['buildx','build','--platform','linux/amd64','--file',context+'/'+plan.dockerfile,'--provenance=mode=max','--network=default',
  '--metadata-file',metadata,'--output','type=oci,dest='+output,context];
}

export function ociBuildReceipt(plan,{metadata,runnerId,artifactHash,artifactBytes,exitCode}){
 requireThat(exitCode===0,'oci_build_failed');text(runnerId);
 const imageDigest=metadata?.['containerimage.digest'];requireThat(/^sha256:[a-f0-9]{64}$/.test(imageDigest),'oci_digest_missing');
 requireThat(/^sha256:[a-f0-9]{64}$/.test(artifactHash)&&Number.isSafeInteger(artifactBytes)&&artifactBytes>0,'oci_artifact_invalid');
 const receipt={version:1,buildPlanId:plan.id,projectId:plan.projectId,sourceHash:plan.sourceHash,runnerId,imageDigest,artifactHash,artifactBytes,evidence:'compiled_only',admission:'requires_review_and_registry_verification'};
 return {...receipt,id:digest(receipt)};
}
