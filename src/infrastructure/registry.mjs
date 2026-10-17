import {digest,requireThat} from '../shared/index.mjs';

// Publication is an explicit project action, not a deployment approval. The
// registry exposes only the verified graph belonging to that exact build.
export function createImageRegistry({store,identity,projects,artifacts,images,origin,now=()=>Date.now()}){
 const host=new URL(origin).host;
 async function source(v,reader=store){
  requireThat(v?.publishSource===true&&await (identity.publishedBuildAllowed?identity.publishedBuildAllowed(v.actor,v.projectId,reader):identity.allowed(v.actor,'build.compile',{projectId:v.projectId},reader)),'not_found');
  const job=(await reader.read('workflow-jobs',v.id))?.value;
  requireThat(job&&!['blocked','cancelled'].includes(job.state),'not_found');
  const published=await projects.publicSource(digest({projectId:v.projectId,id:v.snapshotId}));
  requireThat(published.projectId===v.projectId&&published.snapshotId===v.snapshotId,'not_found');
 }
 const visible=v=>({buildId:v.id,projectId:v.projectId,enabled:v.registry?.enabled===true,image:v.registry?`${host}/claus/${v.id.slice(7)}@${v.registry.imageDigest}`:null,imageDigest:v.registry?.imageDigest??null,sourceHash:v.sourceHash,archiveHash:v.registry?.archiveHash??null,reviewRequired:true});
 return {
  async publish(actor,projectId,{buildId,publishImage,expectedRevision}){
   await identity.authorize(actor,'build.compile',{projectId});
   const row=await store.read('oci-builds',buildId);requireThat(row?.value.projectId===projectId,'not_found');
   requireThat(row.revision===expectedRevision,'revision_conflict');
   requireThat(typeof publishImage==='boolean','invalid_publication');
   let registry=row.value.registry;
   if(publishImage){
    requireThat(row.value.state==='compiled'&&row.value.artifactHash,'build_not_complete');
    await source(row.value);
    requireThat(images?.enabled,'oci_image_storage_unavailable');
    const receipt=await artifacts.get(projectId,row.value.artifactHash);
    requireThat(receipt.buildId===buildId&&receipt.projectId===projectId&&receipt.sourceHash===row.value.sourceHash&&receipt.planId===row.value.planId,'oci_receipt_mismatch');
    registry=registry??await images.publish(projectId,receipt);
   }
   return store.transaction(async tx=>{
    await identity.authorize(actor,'build.compile',{projectId},tx);
    const current=await tx.read('oci-builds',buildId);requireThat(current?.revision===expectedRevision,'revision_conflict');
    if(publishImage)await source(current.value,tx);
    const value={...current.value,registry:registry?{...registry,enabled:publishImage,updatedAt:now()}:null};
    const saved=await tx.write('oci-builds',buildId,value,expectedRevision);
    return {...visible(value),revision:saved.revision};
   });
  },
  async handle(request){
   const path=new URL(request.url).pathname,headers={'docker-distribution-api-version':'registry/2.0','cache-control':'no-store'};
   if(!['GET','HEAD'].includes(request.method))return new Response(null,{status:405,headers:{...headers,allow:'GET, HEAD'}});
   if(path==='/v2/'||path==='/v2')return new Response(request.method==='HEAD'?null:'{}',{headers:{...headers,'content-type':'application/json'}});
   const match=/^\/v2\/claus\/([a-f0-9]{64})\/(manifests|blobs)\/(sha256:[a-f0-9]{64})$/.exec(path);
   if(!match)return new Response(null,{status:404,headers});
   try{
    const v=(await store.read('oci-builds','sha256:'+match[1]))?.value;
    requireThat(v?.registry?.enabled&&v.state==='compiled','not_found');await source(v);
    const member=v.registry.members.find(m=>m.digest===match[3]&&(match[2]!=='manifests'||m.manifest));requireThat(member,'not_found');
    Object.assign(headers,{'docker-content-digest':member.digest,'content-type':match[2]==='manifests'?member.mediaType:'application/octet-stream','content-length':String(member.size)});
    if(request.method==='HEAD')return new Response(null,{headers});
    const data=await images.registryRead(v.projectId,member);
    if(data.bytes)return new Response(data.bytes,{headers});
    delete headers['content-length'];return new Response(null,{status:307,headers:{...headers,location:data.url}});
   }catch(error){return new Response(null,{status:error.code==='not_found'?404:503,headers:{'docker-distribution-api-version':'registry/2.0','cache-control':'no-store'}});}
  }
 };
}
