import { createPublicClient, http } from 'viem';
import { createContractInboxRead } from '../adapters/contract-intake.mjs';
import { digest, requireThat, shape, integer, contentHash } from '../src/shared/index.mjs';
import { createChainAdmission } from '../src/chain-deployments/index.mjs';

// The public API receives only this public deployment pin. It never receives
// a signing key. Omitting the pin keeps all new intake admissions disabled.
export function contractIntakePorts(env = process.env, suppliedClient) {
  if (!env.CLAUS_CONTRACT_INTAKE_PROFILE) return {};
  const pin = JSON.parse(env.CLAUS_CONTRACT_INTAKE_PROFILE);
  shape(pin, ['chainId', 'inbox', 'codeHash', 'dispatcher', 'startBlock', 'reviewProjectId', 'reviewCaseId', 'reviewArtifactHash']);
  requireThat(pin.chainId === 11155111, 'unsupported_chain');
  integer(pin.startBlock, 1); contentHash(pin.reviewArtifactHash);
  const client = suppliedClient ?? createPublicClient({ transport: http('https://ethereum-sepolia-rpc.publicnode.com',
    { retryCount: 0, timeout: 15000 }), cacheTime: 0 });
  const chain = createContractInboxRead({ client, ...pin });
  async function admitted(reader, projectId) {
    const capability = (await reader.read('network-capabilities', 'contract-intake'))?.value;
    if (!capability?.enabled) return false;
    requireThat(capability.profileHash === digest(pin), 'intake_admission_changed');
    const assessment = (await reader.read('contract-intake-admissions', digest(pin)))?.value;
    const review = (await reader.read('review-cases', pin.reviewCaseId))?.value;
    requireThat(assessment?.accepted === true && assessment.profileHash === digest(pin) &&
      review?.projectId === pin.reviewProjectId && review.state === 'reviewed' &&
      review.artifactHash === pin.reviewArtifactHash, 'intake_review_not_admitted');
    if (capability.admissionMode === 'public-readonly-v1') {
      requireThat(assessment.publicAdmission === true, 'intake_review_not_admitted');
      const config = await createChainAdmission({ store: reader, now: () => Date.now() }).admitted(reader);
      if (projectId === undefined) return true;
      const admitted = await reader.read('public-chain-projects', projectId);
      const binding = (await reader.read('chain-bindings', projectId))?.value;
      return !!admitted && binding?.chainId === 11155111 && binding.profile === 'claus-readonly-v1' &&
        binding.executor?.toLowerCase() === config.executor.toLowerCase();
    }
    // Preserve the original project-scoped pilot when public admission is absent.
    requireThat(Array.isArray(capability.projectIds) && capability.projectIds.length > 0 &&
      capability.projectIds.length <= 100 && capability.projectIds.every(id => typeof id === 'string' && id.length > 0) &&
      new Set(capability.projectIds).size === capability.projectIds.length, 'intake_projects_not_admitted');
    if (projectId !== undefined && !capability.projectIds.includes(projectId)) return false;
    return true;
  }
  return { enabled: true, chain, client, pin, verifyAdmission: admitted };
}

export async function contractIntakeHealth(store, ports, now = Date.now()) {
  if (ports.enabled !== true) return 'not_enabled';
  try { if (!await ports.verifyAdmission(store)) return 'not_enabled'; }
  catch (error) {
    if (['intake_admission_changed', 'intake_review_not_admitted', 'intake_projects_not_admitted',
      'chain_public_not_enabled', 'chain_admission_changed', 'chain_scope_not_reviewed'].includes(error.code))
      return 'admission_unavailable';
    throw error;
  }
  const worker = (await store.read('worker-health', 'contract-intake'))?.value;
  const capability = (await store.read('network-capabilities', 'contract-intake'))?.value;
  return worker?.state === 'active' && worker.observedAt > now - 300000 && worker.observedAt <= now &&
    worker.profileHash === digest(ports.pin) && typeof capability?.workerRelease === 'string' &&
    worker.release === capability.workerRelease ? capability.admissionMode === 'public-readonly-v1' ? 'public_readonly' : 'restricted_pilot' : 'worker_unavailable';
}

