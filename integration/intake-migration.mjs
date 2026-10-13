import {requireThat} from '../src/shared/index.mjs';

// One explicit, idempotent Sepolia namespace migration. Old keys are retained;
// cursors and job/request/transaction IDs already bind their original chain.
// Never copy old worker observations into a new namespace as fresh health.
export async function migrateSepoliaIntake(store,{profileHash,expectedRevision}) {
 return store.transaction(async tx=>{
  const current=await tx.read('network-capabilities','contract-intake:11155111');
  if(current){requireThat(current.value.profileHash===profileHash,'intake_admission_changed');return {state:'already_migrated',revision:current.revision};}
  const legacy=await tx.read('network-capabilities','contract-intake');
  requireThat(legacy?.revision===expectedRevision && legacy.value.profileHash===profileHash,'intake_admission_changed');
  const saved=await tx.write('network-capabilities','contract-intake:11155111',legacy.value,0);
  await tx.write('contract-intake-migrations','sepolia-namespace-v1',{chainId:11155111,profileHash,legacyRevision:legacy.revision,
   requestIdsPreserved:true,cursorsPreserved:true,healthCopied:false},0);
  return {state:'migrated',revision:saved.revision};
 });
}
