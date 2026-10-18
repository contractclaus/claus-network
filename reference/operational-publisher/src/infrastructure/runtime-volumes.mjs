import {resourceStore} from '../resources/store.mjs';
import {volumeProvider} from '../resources/volume-provider.mjs';
import {publisherRepository} from '../publisher/repository.js';
const fail=c=>{throw Error('infrastructure_volume_'+c);};
export function volumeReference(work){
 const v=work.manifest?.networkVolume;
 if(v===undefined){if((work.manifest?.storageGiB??0)!==0)fail('reference_required');return null;}
 if(!v||Object.keys(v).length!==2||!/^res_[a-f0-9]{24}$/.test(v.resourceId??'')||typeof v.path!=='string'||v.path.length>200||!/^\/[A-Za-z0-9_./-]+$/.test(v.path)||v.path.split('/').slice(1).some(p=>!p||p==='.'||p==='..')||!Number.isSafeInteger(work.manifest.storageGiB)||work.manifest.storageGiB<10||work.manifest.storageGiB>4096)fail('reference_invalid');
 return v;
}
export function runtimeVolumes({store,provider=volumeProvider(),workStatus=id=>publisherRepository().workStatus(id),now=Date.now}={}){
 const data=()=>store??=resourceStore();
 async function identity(work){
  const ref=volumeReference(work);if(!ref)return null;
  const r=await data().get('resource',ref.resourceId);
  if(!r||r.kind!=='managed-network-volume'||r.provider!=='runpod'||r.projectId!==work.projectId||r.region!==work.manifest.region||work.manifest.storageGiB>r.sizeGb)fail('binding_mismatch');
  return {resource:r,mount:{volumeId:r.providerId,path:ref.path}};
 }
 async function active(work){
  const b=await identity(work);if(!b)return true;
  return b.resource.status==='active'&&Date.parse(b.resource.fundedUntil)>now()&&['ready','working','waiting'].includes(await workStatus(b.resource.workId));
 }
 async function load(work){
  const b=await identity(work);if(!b)return null;
  if(!await active(work))fail('inactive');
  const requiredUntil=work.leaseUntil??now()+(work.leaseSeconds??60)*1000;
  if(Date.parse(b.resource.fundedUntil)<requiredUntil)fail('renew_storage_before_compute_lease');
  const v=await provider.read(b.resource.providerId);
  if(!v||v.name!==b.resource.providerName||v.size!==b.resource.sizeGb||v.dataCenter!==b.resource.region||v.type!=='STANDARD')fail('provider_changed');
  return b.mount;
 }
 async function matches(pod,work){
  const b=await identity(work),actual=pod.mounts?.network??[];
  if(b&&(actual.length!==1||actual[0].volumeId!==b.mount.volumeId||actual[0].path!==b.mount.path)||!b&&actual.length)fail('pod_binding_changed');
 }
 return {identity,active,load,matches};
}
