import {requireThat} from '../shared/index.mjs';
import {CLAUS_IDENTITY} from '../partner-launch/policy.mjs';
export function validateSecretBindings(bindings=[]){
 requireThat(Array.isArray(bindings)&&bindings.length<=32,'runtime_secret_bindings_invalid');
 const names=new Set();
 for(const b of bindings){
  requireThat(b&&Object.keys(b).length===3&&typeof b.envName==='string'&&/^[A-Z][A-Z0-9_]{1,100}$/.test(b.envName)&&!/^(?:NEXT_PUBLIC_|PUBLIC_|VITE_|VERCEL_|NODE_)/.test(b.envName)&&/^sec_[a-f0-9]{24}$/.test(b.secretId??'')&&Number.isSafeInteger(b.version)&&b.version>=1&&!names.has(b.envName),'runtime_secret_bindings_invalid');
  names.add(b.envName);
 }
 return bindings;
}
export function requireSecretBindingOwner(manifest,owner){
 if(validateSecretBindings(manifest.secretBindings).length)requireThat(owner?.chainId===1&&owner.address?.toLowerCase()===CLAUS_IDENTITY,'runtime_image_secret_owner_required');
}
