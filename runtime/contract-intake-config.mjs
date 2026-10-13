import { createPublicClient, http } from 'viem';
import { createContractInboxRead } from '../adapters/contract-intake.mjs';
import { digest, requireThat, shape, integer, contentHash } from '../src/shared/index.mjs';
import { createChainAdmission } from '../src/chain-deployments/index.mjs';

export async function intakeCapability(reader, chainId) {
  const key = 'contract-intake:' + chainId;
  const row = await reader.read('network-capabilities', key);
  if (row || chainId !== 11155111) return { key, value: row?.value };
  return { key: 'contract-intake', value: (await reader.read('network-capabilities', 'contract-intake'))?.value };
}

// The API has only public pins and read transports. Each signing host selects
// one pin. Legacy Sepolia keys stay readable until its explicit migration.
export function contractIntakePorts(env = process.env, suppliedClient) {
  requireThat(!(env.CLAUS_CONTRACT_INTAKE_PROFILE && env.CLAUS_CONTRACT_INTAKE_PROFILES), 'ambiguous_intake_profiles');
  if (!env.CLAUS_CONTRACT_INTAKE_PROFILE && !env.CLAUS_CONTRACT_INTAKE_PROFILES) return {};
  const pins = env.CLAUS_CONTRACT_INTAKE_PROFILES ? JSON.parse(env.CLAUS_CONTRACT_INTAKE_PROFILES) :
    [JSON.parse(env.CLAUS_CONTRACT_INTAKE_PROFILE)];
  requireThat(Array.isArray(pins) && pins.length > 0 && pins.length <= 2 &&
    new Set(pins.map(pin => pin?.chainId)).size === pins.length, 'invalid_intake_profiles');
  const byChain = new Map(pins.map(pin => [pin.chainId, single(pin,
    suppliedClient instanceof Map ? suppliedClient.get(pin.chainId) : suppliedClient)]));
  const selected = chainId => {
    const ports = byChain.get(chainId); requireThat(ports, 'contract_intake_disabled'); return ports;
  };
  if (pins.length === 1) return { ...byChain.get(pins[0].chainId), byChain };
  return { enabled: true, byChain, chain: {
    profile: chainId => selected(chainId).chain.profile(),
    observe: (binding, pointer) => selected(binding.chainId).chain.observe(binding, pointer),
    pending: (binding, observation) => selected(binding.chainId).chain.pending(binding, observation)
  }, async verifyAdmission(reader, projectId) {
    requireThat(typeof projectId === 'string', 'project_chain_required');
    const chainId = (await reader.read('chain-bindings', projectId))?.value.chainId ?? 11155111;
    return selected(chainId).verifyAdmission(reader, projectId);
  } };

  function single(pin, supplied) {
    shape(pin, ['chainId', 'inbox', 'codeHash', 'dispatcher', 'startBlock', 'reviewProjectId', 'reviewCaseId', 'reviewArtifactHash']);
    requireThat([1, 11155111].includes(pin.chainId), 'unsupported_chain');
    integer(pin.startBlock, 1); contentHash(pin.reviewArtifactHash);
    const rpcUrl = pin.chainId === 1 ? env.CLAUS_MAINNET_RPC_URL :
      env.CLAUS_SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
    requireThat(typeof rpcUrl === 'string' && new URL(rpcUrl).protocol === 'https:', 'historical_rpc_required');
    const client = supplied ?? createPublicClient({ transport: http(rpcUrl,
      { retryCount: 0, timeout: 15000 }), cacheTime: 0 });
    const chain = createContractInboxRead({ client, ...pin });
    async function admitted(reader, projectId) {
      const capability = (await intakeCapability(reader, pin.chainId)).value;
      if (!capability?.enabled) return false;
      requireThat(capability.profileHash === digest(pin), 'intake_admission_changed');
      const assessment = (await reader.read('contract-intake-admissions', digest(pin)))?.value;
      const review = (await reader.read('review-cases', pin.reviewCaseId))?.value;
      requireThat(assessment?.accepted === true && assessment.profileHash === digest(pin) &&
        review?.projectId === pin.reviewProjectId && review.state === 'reviewed' &&
        review.artifactHash === pin.reviewArtifactHash, 'intake_review_not_admitted');
      if (['public-readonly-v1','public-reviewed-v1'].includes(capability.admissionMode)) {
        requireThat(assessment.publicAdmission === true, 'intake_review_not_admitted');
        const binding = projectId === undefined ? null : (await reader.read('chain-bindings', projectId))?.value;
        const profile = binding?.profile ?? 'claus-readonly-v1';
        if (profile !== 'claus-readonly-v1') {
          requireThat(capability.admissionMode === 'public-reviewed-v1' && profile === 'claus-managed-v1' &&
            capability.profiles?.includes(profile) && assessment.profiles?.includes(profile), 'intake_profile_not_admitted');
        }
        const config = await createChainAdmission({ store: reader, now: () => Date.now(), chainId: pin.chainId, profile }).admitted(reader);
        if (projectId === undefined) return true;
        const admitted = await reader.read('public-chain-projects', projectId);
        return !!admitted && (admitted.value.chainId ?? 11155111) === pin.chainId &&
          binding?.chainId === pin.chainId && binding.profile === profile && (admitted.value.profile ?? 'claus-readonly-v1') === profile &&
          binding.executor?.toLowerCase() === config.executor.toLowerCase();
      }
      requireThat(Array.isArray(capability.projectIds) && capability.projectIds.length > 0 &&
        capability.projectIds.length <= 100 && capability.projectIds.every(id => typeof id === 'string' && id.length > 0) &&
        new Set(capability.projectIds).size === capability.projectIds.length, 'intake_projects_not_admitted');
      if (projectId !== undefined) {
        const binding = (await reader.read('chain-bindings', projectId))?.value;
        if (binding && binding.chainId !== pin.chainId || !capability.projectIds.includes(projectId)) return false;
      }
      return true;
    }
    return { enabled: true, chain, client, pin, verifyAdmission: admitted };
  }
}

export async function contractIntakeHealth(store, allPorts, now = Date.now(), chainId = 11155111) {
  const ports = allPorts.byChain?.get(chainId) ??
    ((allPorts.pin?.chainId ?? 11155111) === chainId ? allPorts : {});
  if (ports.enabled !== true) return 'not_enabled';
  try { if (!await ports.verifyAdmission(store)) return 'not_enabled'; }
  catch (error) {
    if (['intake_admission_changed', 'intake_review_not_admitted', 'intake_projects_not_admitted',
      'chain_public_not_enabled', 'chain_admission_changed', 'chain_scope_not_reviewed'].includes(error.code))
      return 'admission_unavailable';
    throw error;
  }
  const { key, value: capability } = await intakeCapability(store, chainId);
  const worker = (await store.read('worker-health', key))?.value;
  return worker?.state === 'active' && !worker.scanError && worker.observedAt > now - 300000 && worker.observedAt <= now &&
    worker.profileHash === digest(ports.pin) && typeof capability?.workerRelease === 'string' &&
    worker.release === capability.workerRelease ? capability.admissionMode === 'public-reviewed-v1' ? 'public_reviewed' : capability.admissionMode === 'public-readonly-v1' ? 'public_readonly' : 'restricted_pilot' : 'worker_unavailable';
}
