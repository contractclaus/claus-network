// A small composition of existing operations, not a separate publishing service.
export async function publishSite({client,slug,name,description,files}) {
  if(!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(slug)||!Array.isArray(files)||!files.some(f=>f.path==='index.html'))throw Error('Invalid site input');
  let after='',project;const seen=new Set();
  do {
    const page=await client.call('project_list',{limit:100,...(after?{after}:{})});
    project=page.items.find(p=>p.slug===slug);after=page.nextCursor??'';
    if(after&&seen.has(after))throw Error('Repeated project cursor');seen.add(after);
  }while(after&&!project);
  project??=await client.call('project_create',{slug,name,idempotencyKey:'site:'+slug});
  const projectId=project.id;
  const current=await client.call('project_get',{projectId});
  const snapshot=await client.call('snapshot_create',{projectId,files,expectedProjectRevision:current.revision});
  const release=await client.call('release_create',{projectId,snapshotId:snapshot.id,paths:files.map(f=>f.path)});
  const prior=await client.call('release_get',{projectId,releaseId:release.id});
  if(!prior.publication?.published)await client.call('release_publish',{
    projectId,releaseId:release.id,published:true,expiresAt:null,expectedRevision:prior.publication?.revision??0
  });
  // Re-read after publication; do not overwrite an unrelated profile revision.
  const profile=await client.call('project_get',{projectId});
  const publicDescription=description??profile.publication.description??'';
  if(!profile.publication.published||profile.publication.description!==publicDescription)await client.call('project_publish',{
    projectId,published:true,description:publicDescription,expectedRevision:profile.publication.revision
  });
  const verified=await client.call('public_release_file',{releaseId:release.id,filePath:'index.html'});
  if(verified.projectId!==projectId||verified.file?.content!==files.find(f=>f.path==='index.html').content)throw Error('Published content differs');
  const publicProject=await client.call('public_project',{slug});
  const active=(publicProject.releases??[]).filter(r=>r.expiresAt===null||r.expiresAt>Date.now())
    .sort((a,b)=>b.createdAt-a.createdAt||b.id.localeCompare(a.id))[0];
  if(publicProject.projectId!==projectId||active?.id!==release.id)
    throw Error('This release is not the active project website. A newer release or an operator selection may be active. Read the public project before changing its publications.');
  return {projectId,releaseId:release.id,projectUrl:'https://claus.si/c/'+slug,siteUrl:release.url,
    mapUrl:'https://claus.si/Home#project='+encodeURIComponent(slug),expiresAt:prior.publication?.published?prior.publication.expiresAt:null};
}
