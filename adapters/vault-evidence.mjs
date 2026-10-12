import { keccak256 } from 'viem';
import { digest, requireThat } from '../src/shared/index.mjs';
import { vaultAbi } from './vault-read.mjs';

// The only immutable in this reviewed profile is the admission-policy address.
// Compare the complete deployed runtime after inserting that constructor value.
export function validateVaultRuntime(build, buildHash, policy, code) {
  requireThat(digest(build) === buildHash && build.status === 'compiled' &&
    build.contract === 'ClausNativeVault' && build.profile?.profile === 'solidity-static-compile-v1' &&
    build.profile.compiler === '0.8.27+commit.40a35a09.Emscripten.clang' &&
    digest(build.standardInput) === build.inputHash &&
    keccak256(build.runtimeTemplate) === build.runtimeTemplateHash, 'vault_evidence_invalid');
  const groups = Object.values(build.immutableReferences ?? {});
  requireThat(groups.length === 1 && Array.isArray(groups[0]) && groups[0].length > 0,
    'vault_evidence_invalid');
  let runtime = build.runtimeTemplate.slice(2);
  const word = policy.toLowerCase().slice(2).padStart(64, '0'), used = new Set();
  for (const ref of groups[0]) {
    requireThat(Number.isSafeInteger(ref.start) && ref.start >= 0 && ref.length === 32 &&
      (ref.start + 32) * 2 <= runtime.length, 'vault_evidence_invalid');
    for (let i = ref.start; i < ref.start + 32; i++) {
      requireThat(!used.has(i), 'vault_evidence_invalid'); used.add(i);
    }
    requireThat(/^0{64}$/.test(runtime.slice(ref.start * 2, (ref.start + 32) * 2)), 'vault_evidence_invalid');
    runtime = runtime.slice(0, ref.start * 2) + word + runtime.slice((ref.start + 32) * 2);
  }
  requireThat('0x' + runtime === code.toLowerCase(), 'vault_evidence_invalid');
}

export async function captureVaultConsumer({ client, contract, consumer, blockNumber }) {
  const { vault, build, review } = consumer;
  requireThat(vault.state === 'verified' && vault.chainId === 11155111 &&
    vault.profile === 'claus-native-principal-v1' && review.complete === true &&
    digest(review) === vault.reviewArtifactHash, 'vault_evidence_invalid');
  const deployed = await contract(vault.address, blockNumber);
  requireThat(deployed.codeHash === vault.codeHash, 'vault_evidence_invalid');
  const owner = vault.policy.owner.toLowerCase();
  const [policy, total, principal] = await Promise.all([
    client.readContract({ address: vault.address, abi: vaultAbi, functionName: 'admissionPolicy', blockNumber }),
    client.readContract({ address: vault.address, abi: vaultAbi, functionName: 'totalPrincipal', blockNumber }),
    client.readContract({ address: vault.address, abi: vaultAbi, functionName: 'principal', args: [owner], blockNumber })
  ]);
  requireThat(policy.toLowerCase() === vault.policy.target.toLowerCase(), 'vault_evidence_invalid');
  validateVaultRuntime(build, vault.artifactHash, policy, deployed.code);
  return { profile: vault.profile, projectId: vault.projectId, vault: deployed, policy: policy.toLowerCase(), owner,
    totalPrincipalWei: total.toString(), ownerPrincipalWei: principal.toString(), build, buildHash: vault.artifactHash,
    review: { provider: 'imd-audit-v1', jobId: review.jobId, artifactHash: vault.reviewArtifactHash,
      report: review.report, reportHash: digest(review.report) } };
}
