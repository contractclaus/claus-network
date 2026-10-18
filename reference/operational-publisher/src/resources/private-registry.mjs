import {createHash} from 'node:crypto';
const fail=c=>{throw Error('resource_registry_'+c);};
const hash=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const digest=v=>typeof v==='string'&&/^sha256:[a-f0-9]{64}$/.test(v);
const media='application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json';
async function bytes(r,max=4000000){if(!r.ok){await r.body?.cancel();fail('http_'+r.status);}let n=0;const chunks=[];for await(const c of r.body){n+=c.length;if(n>max)fail('response_too_large');chunks.push(c);}return Buffer.concat(chunks);}
export function privateRegistry({request=fetch,token=()=>process.env.RESOURCE_GITHUB_PACKAGES_TOKEN}={}){
 async function inspect({repository,imageDigest,source,actionId,architecture}){
  if(!/^claus-[a-z0-9-]+$/.test(repository??'')||!digest(imageDigest)||! /^[a-f0-9]{40}$/.test(source??'')||!/^act_[a-f0-9]{24}$/.test(actionId??'')||!['amd64','arm64'].includes(architecture))fail('reference_invalid');
  if(!token())fail('private_read_access_missing');
  const p=await request('https://api.github.com/users/contractclaus/packages/container/'+encodeURIComponent(repository),{headers:{authorization:'Bearer '+token(),accept:'application/vnd.github+json','x-github-api-version':'2026-03-10'},redirect:'error',signal:AbortSignal.timeout(15000)});
  const info=JSON.parse((await bytes(p)).toString());if(info.visibility!=='private'||info.name!==repository||info.owner?.login!=='contractclaus')fail('private_package_scope_changed');
  const path='contractclaus/'+repository;
  const t=await request('https://ghcr.io/token?service=ghcr.io&scope='+encodeURIComponent('repository:'+path+':pull'),{headers:{authorization:'Basic '+Buffer.from('contractclaus:'+token()).toString('base64')},redirect:'error',signal:AbortSignal.timeout(15000)});
  const auth=JSON.parse((await bytes(t,32000)).toString()).token;if(typeof auth!=='string'||!auth)fail('authentication_invalid');
  async function get(kind,id,limit=4000000){
   if(!digest(id))fail('digest_invalid');
   let r=await request('https://ghcr.io/v2/'+path+'/'+kind+'/'+id,{headers:{authorization:'Bearer '+auth,accept:media},redirect:'manual',signal:AbortSignal.timeout(15000)});
   if([302,307].includes(r.status)){
    const u=new URL(r.headers.get('location'));await r.body?.cancel();
    if(u.protocol!=='https:'||u.username||u.password||!(u.hostname==='pkg-containers.githubusercontent.com'||u.hostname.endsWith('.blob.core.windows.net')))fail('download_origin_changed');
    r=await request(u,{redirect:'error',signal:AbortSignal.timeout(15000)});
   }
   const raw=await bytes(r,limit);if(hash(raw)!==id)fail('digest_mismatch');return JSON.parse(raw.toString());
  }
  const root=await get('manifests',imageDigest);let manifest=root;
  if(Array.isArray(root.manifests)){
   const choices=root.manifests.filter(m=>m.platform?.os==='linux'&&m.platform.architecture===architecture);if(choices.length!==1)fail('platform_ambiguous');manifest=await get('manifests',choices[0].digest);
  }
  if(manifest.schemaVersion!==2||!Array.isArray(manifest.layers)||!digest(manifest.config?.digest))fail('manifest_invalid');
  const config=await get('blobs',manifest.config.digest),labels=config.config?.Labels;
  if(config.os!=='linux'||config.architecture!==architecture||labels?.['org.opencontainers.image.source']!=='https://github.com/'+path||labels?.['org.opencontainers.image.revision']!==source||labels?.['si.claus.action']!==actionId)fail('source_binding_changed');
  let compressedBytes=0;for(const layer of manifest.layers){if(!digest(layer.digest)||!Number.isSafeInteger(layer.size)||layer.size<0)fail('layer_invalid');compressedBytes+=layer.size;}
  if(!Number.isSafeInteger(compressedBytes))fail('size_invalid');
  return {image:'ghcr.io/'+path+'@'+imageDigest,imageDigest,architecture,compressedBytes,private:true,configDigest:manifest.config.digest,layerDigests:manifest.layers.map(l=>l.digest)};
 }
 return {inspect};
}
