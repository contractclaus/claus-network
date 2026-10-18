import {requireThat} from '../shared/index.mjs';
export function validateNetworkVolume(manifest){
 const v=manifest.networkVolume;
 if(v===undefined){requireThat((manifest.storageGiB??0)===0,'runtime_volume_reference_required');return null;}
 requireThat(v&&Object.keys(v).length===2&&/^res_[a-f0-9]{24}$/.test(v.resourceId??'')&&typeof v.path==='string'&&v.path.length<=200&&/^\/[A-Za-z0-9_./-]+$/.test(v.path)&&v.path.split('/').slice(1).every(p=>p&&p!=='.'&&p!=='..')&&Number.isSafeInteger(manifest.storageGiB)&&manifest.storageGiB>=10&&manifest.storageGiB<=4096,'runtime_volume_reference_invalid');
 return v;
}
