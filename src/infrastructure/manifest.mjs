import {canonical,copy,contentHash,integer,requireThat,shape,text} from '../shared/index.mjs';

export const INFRASTRUCTURE_VERSION='claus-infrastructure/1';
const MODES=['http','worker','job','model'];
export function validateManifest(input) {
  shape(input,['version','mode','image','region','cpu','memoryMiB','gpu','port','healthPath','command','storageGiB','releaseHash']);
  requireThat(input.version===1&&MODES.includes(input.mode),'invalid_infrastructure_manifest');
  requireThat(typeof input.image==='string'&&/^[a-z0-9.-]+\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(input.image),'immutable_image_required');
  requireThat(typeof input.region==='string'&&/^[A-Za-z0-9-]{2,40}$/.test(input.region),'invalid_region');
  integer(input.cpu,1,64);integer(input.memoryMiB,256,524288);integer(input.storageGiB,0,2000);
  requireThat(input.gpu===null||typeof input.gpu==='string'&&/^[A-Za-z0-9 _.-]{1,100}$/.test(input.gpu),'invalid_gpu');
  requireThat(Array.isArray(input.command)&&input.command.length<=32&&input.command.every(x=>typeof x==='string'&&x.length<=1000&&!x.includes('\0')),'invalid_command');
  if(['http','model'].includes(input.mode)) {
    integer(input.port,1024,65535);
    requireThat(typeof input.healthPath==='string'&&/^\/[A-Za-z0-9/_-]{0,100}$/.test(input.healthPath),'invalid_health_path');
  } else requireThat(input.port===null&&input.healthPath===null,'unexpected_service_port');
  contentHash(input.releaseHash);requireThat(Buffer.byteLength(canonical(input))<=8192,'manifest_too_large');
  return copy(input);
}

export function validateProfile(input) {
  shape(input,['id','enabled','provider','accountId','asset','fundingAccount','permissionHash','maxLeaseSeconds','maxPerLease','maxActive','imagePrefixes','regions','maxCpu','maxMemoryMiB','maxStorageGiB','gpuTypes']);
  for(const key of ['id','provider','accountId','asset','fundingAccount'])text(input[key]);
  requireThat(['fly','runpod'].includes(input.provider)&&typeof input.enabled==='boolean','invalid_infrastructure_profile');
  contentHash(input.permissionHash);integer(input.maxLeaseSeconds,60,86400);integer(input.maxActive,1,100);
  requireThat(typeof input.maxPerLease==='string'&&/^[1-9][0-9]{0,17}$/.test(input.maxPerLease),'invalid_infrastructure_limit');
  integer(input.maxCpu,1,64);integer(input.maxMemoryMiB,256,524288);integer(input.maxStorageGiB,0,2000);
  for(const key of ['imagePrefixes','regions','gpuTypes'])requireThat(Array.isArray(input[key])&&input[key].length<=100&&new Set(input[key]).size===input[key].length&&input[key].every(x=>typeof x==='string'&&x.length>0&&x.length<=200),'invalid_profile_allowlist');
  requireThat(input.imagePrefixes.length>0&&input.imagePrefixes.every(x=>/^[a-z0-9.-]+\/[a-z0-9._/-]+\/$/.test(x))&&input.regions.length>0,'invalid_profile_allowlist');
  return copy(input);
}

export function matchManifest(profile,manifest) {
  requireThat(profile.imagePrefixes.some(p=>manifest.image.startsWith(p))&&profile.regions.includes(manifest.region),'infrastructure_target_not_allowed');
  requireThat(manifest.cpu<=profile.maxCpu&&manifest.memoryMiB<=profile.maxMemoryMiB&&manifest.storageGiB<=profile.maxStorageGiB,'infrastructure_size_not_allowed');
  requireThat(manifest.gpu===null||profile.gpuTypes.includes(manifest.gpu),'infrastructure_gpu_not_allowed');
  requireThat(profile.provider!=='fly'||manifest.gpu===null,'infrastructure_gpu_not_supported');
}
