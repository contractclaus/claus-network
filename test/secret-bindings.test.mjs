import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSecretBindings,requireSecretBindingOwner} from '../src/infrastructure/secret-bindings.mjs';
import {CLAUS_IDENTITY} from '../src/partner-launch/policy.mjs';
test('application secret references remain bound to Claus ownership and unique private environment names',()=>{
 const binding={envName:'MODEL_API_KEY',secretId:'sec_'+'a'.repeat(24),version:1};
 assert.deepEqual(validateSecretBindings([binding]),[binding]);
 requireSecretBindingOwner({secretBindings:[binding]},{chainId:1,address:CLAUS_IDENTITY});
 assert.throws(()=>requireSecretBindingOwner({secretBindings:[binding]},{chainId:1,address:'0x'+'1'.repeat(40)}),/secret_owner_required/);
 assert.throws(()=>validateSecretBindings([binding,binding]),/bindings_invalid/);
 assert.throws(()=>validateSecretBindings([{...binding,envName:'NEXT_PUBLIC_KEY'}]),/bindings_invalid/);
 requireSecretBindingOwner({},null);
});
