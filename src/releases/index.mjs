import { canonical, digest, integer, requireThat, text } from '../shared/index.mjs';

export function createReleases({ store, identity, projects, artifacts, admit = async () => {}, now = () => Date.now() }) {
  const origin='https://claus-network-sites.vercel.app';
  async function owned(actor,projectId,id,reader=store){
    await identity.authorize(actor,'resource.read',{projectId},reader);
    const row=await reader.read('project-releases',text(id));
    requireThat(row?.value.projectId===projectId,'not_found');return row;
  }
  return {
    async create(actor,projectId,{snapshotId,paths}){
      requireThat(Array.isArray(paths)&&paths.length>0&&paths.length<=32&&new Set(paths).size===paths.length&&
        paths.includes('index.html'),'invalid_release_files');
      const source=await projects.files(actor,projectId,snapshotId);
      const files=paths.map(path=>{const file=source.find(f=>f.path===path);
        requireThat(file&&/\.(html|css|js|json|svg)$/.test(path),'invalid_release_files');
        return{path:file.path,content:file.content,hash:file.hash};}).sort((a,b)=>a.path.localeCompare(b.path,'en'));
      requireThat(Buffer.byteLength(canonical(files))<=192000,'release_too_large');
      const id=digest({projectId,snapshotId,paths:files.map(f=>f.path)});
      return store.transaction(async tx=>{
        await identity.authorize(actor,'release.publish',{projectId},tx);
        await admit(projectId,tx);
        const old=await tx.read('project-releases',id);if(old)return old.value;
        const capacity=await tx.read('release-capacity',projectId);
        requireThat((capacity?.value.count??0)<32,'capacity_reached');
        const contentHash=await artifacts.put(tx,projectId,files);
        const value={id,projectId,snapshotId,contentHash,paths:files.map(f=>f.path),createdAt:now(),
          isolation:'opaque-origin-static-v1',url:origin+'/r/'+id.slice(7)+'/index.html'};
        await tx.write('project-releases',id,value,0);
        await tx.write('release-capacity',projectId,{count:(capacity?.value.count??0)+1},capacity?.revision??0);
        return value;
      });
    },
    async get(actor,projectId,releaseId){
      const row=await owned(actor,projectId,releaseId);
      const publication=await store.read('release-publications',releaseId);
      return{...row.value,publication:publication?{...publication.value,revision:publication.revision}:null};
    },
    async publish(actor,projectId,{releaseId,published,expiresAt,expectedRevision}){
      requireThat(typeof published==='boolean','invalid_publication');integer(expectedRevision);
      if(published)integer(expiresAt,now()+60000,now()+30*86400000);
      else integer(expiresAt);
      return store.transaction(async tx=>{
        await identity.authorize(actor,'release.publish',{projectId},tx);
        if(published)await admit(projectId,tx);
        const release=(await tx.read('project-releases',text(releaseId)))?.value;
        requireThat(release?.projectId===projectId,'not_found');
        const row=await tx.write('release-publications',releaseId,{projectId,published,expiresAt,updatedAt:now()},expectedRevision);
        const key=projectId+':'+releaseId,index=await tx.read('project-public-releases',key);
        await tx.write('project-public-releases',key,{releaseId,published,expiresAt},index?.revision??0);
        await tx.event({type:published?'release.published':'release.withdrawn',projectId,releaseId,at:now()});
        return{releaseId,...row.value,revision:row.revision};
      });
    },
    async publicForProject(projectId){
      const rows=await store.list('project-public-releases',{prefix:projectId+':',limit:100}),result=[];
      for(const row of rows)if(row.value.published&&row.value.expiresAt>now()){
        const release=(await store.read('project-releases',row.value.releaseId)).value;
        result.push({id:release.id,url:release.url,createdAt:release.createdAt,expiresAt:row.value.expiresAt,isolation:release.isolation});
      }
      return result;
    },
    async public(releaseId){
      const publication=(await store.read('release-publications',text(releaseId)))?.value;
      requireThat(publication?.published&&publication.expiresAt>now(),'not_found');
      const release=(await store.read('project-releases',releaseId)).value;
      const files=await artifacts.get(release.projectId,release.contentHash);
      return{...release,expiresAt:publication.expiresAt,files};
    }
  };
}
