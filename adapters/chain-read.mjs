import { encodeAbiParameters, keccak256, stringToHex, verifyTypedData } from 'viem';
import { ClausApprovalExecutorAbi as readonlyExecutorAbi, ClausReadonlyProjectAbi as readonlyTargetAbi } from './chain-abi.mjs';
import { digest, requireThat } from '../src/shared/index.mjs';
import { createChainEvidence, validateBuildEvidence } from './chain-evidence.mjs';
import { MANAGED_PROFILE, chainProfile } from '../src/chain-deployments/profiles.mjs';
import { captureManagedState, assertManagedSnapshot, validateManagedState } from './managed-evidence.mjs';
import { validateManagedModule } from './managed-module.mjs';
import { ClausManagedExecutorAbi, ClausManagedProjectAbi } from './managed-abi.mjs';
export { validateBuildEvidence } from './chain-evidence.mjs';

export const CHAIN_ID = 11155111;
export const PROFILE = 'claus-readonly-v1';
// A replacement becomes the default for new registrations. Already signed
// registrations and existing projects keep their exact executor and artifacts.
// Retained entries are operator configuration, never client-supplied addresses.
export function selectExecutorCapability(current, executor = current?.executor) {
  requireThat(current && typeof executor === 'string', 'executor_not_enabled');
  const matches = value => value?.executor?.toLowerCase() === executor.toLowerCase();
  const selected = matches(current) ? current : current.retainedExecutors?.find(matches);
  requireThat(selected, 'executor_not_enabled');
  const result = { enabled: current.enabled === true && selected.enabled === true };
  for (const key of ['profile', 'chainId', 'executor', 'executorCodeHash', 'approvalSigner',
    'executorPayer', 'artifactProjectId', 'targetArtifactHash']) result[key] = selected[key];
  return result;
}
const fields = entries => entries.map(([name, type]) => ({ name, type }));
export const registrationTypes = { Registration: fields([
  ['projectId', 'bytes32'], ['owner', 'address'], ['salt', 'bytes32'], ['implementation', 'address'], ['codeHash', 'bytes32'],
  ['initCallHash', 'bytes32'], ['mandateHash', 'bytes32'], ['policyVersion', 'bytes32'], ['minDelaySeconds', 'uint64'], ['nonce', 'uint256'], ['expiresAt', 'uint64']
]) };
export const approvalTypes = { Approval: fields([
  ['projectId', 'bytes32'], ['chainId', 'uint256'], ['executor', 'address'], ['target', 'address'], ['fromVersion', 'uint64'],
  ['fromCodeHash', 'bytes32'], ['implementation', 'address'], ['toCodeHash', 'bytes32'], ['initCallHash', 'bytes32'],
  ['dependencySnapshotHash', 'bytes32'], ['evidenceHash', 'bytes32'], ['policyVersion', 'bytes32'], ['policyGeneration', 'uint64'],
  ['authorityGeneration', 'uint64'], ['clausGeneration', 'uint64'], ['mandateHash', 'bytes32'], ['nonce', 'uint256'], ['notBefore', 'uint64'], ['expiresAt', 'uint64']
]) };
export const domain = (executor, chainId = CHAIN_ID, profile = PROFILE) => {
  chainProfile(chainId, profile);
  return { name: profile === MANAGED_PROFILE ? 'Claus Managed Network' : 'Claus Network', version: '1', chainId, verifyingContract: executor };
};
export function approvalMessage(p, evidenceHash) {
  const { profile, configuration, projectKey, ...rest } = p;
  chainProfile(p.chainId, profile);
  return { ...rest, projectId: projectKey, initCallHash: keccak256(configuration), evidenceHash };
}
export function validateModule(artifact) {
  requireThat(artifact?.status === 'compiled' && artifact.profile?.profile === 'solidity-static-compile-v1' &&
    Object.keys(artifact.immutableReferences ?? {}).length === 0 && /^0x[0-9a-f]+$/.test(artifact.creationBytecode), 'unsupported_module');
  const functions = artifact.abi.filter(x => x.type === 'function');
  requireThat(functions.every(x => ['pure', 'view'].includes(x.stateMutability)) &&
    artifact.abi.every(x => !['receive', 'fallback'].includes(x.type) && (x.type !== 'constructor' || x.inputs.length === 0)) &&
    functions.some(x => x.name === 'evaluate' && x.inputs.map(y => y.type).join(',') === 'bytes,bytes' &&
      x.outputs.map(y => y.type).join(',') === 'bytes'), 'unsupported_module');
  requireThat(keccak256(artifact.runtimeTemplate) === artifact.runtimeTemplateHash, 'artifact_corrupt');
}

export function createChainRead({ client, chainId = CHAIN_ID, profile = PROFILE }) {
  chainProfile(chainId, profile);
  const managed = profile === MANAGED_PROFILE;
  const executorAbi = managed ? ClausManagedExecutorAbi : readonlyExecutorAbi;
  const targetAbi = managed ? ClausManagedProjectAbi : readonlyTargetAbi;
  const moduleValidator = managed ? validateManagedModule : validateModule;
  requireThat([1, CHAIN_ID].includes(chainId), 'unsupported_chain');
  const evidence = createChainEvidence({ client, chainId });
  async function correctChain() { requireThat(await client.getChainId() === chainId, 'wrong_chain'); }
  async function capabilityMatches(capability) {
    await correctChain();
    requireThat(capability.enabled === true && capability.chainId === chainId && capability.profile === profile,
      'unsupported_profile');
    requireThat(keccak256(await client.getCode({ address: capability.executor })) === capability.executorCodeHash,
      'executor_code_changed');
  }
  const read = (address, functionName, args = [], abi = executorAbi) => client.readContract({ address, abi, functionName, args });
  async function state(binding) {
    requireThat((binding.profile ?? PROFILE) === profile, 'project_profile_mismatch');
    await correctChain();
    const p = await read(binding.executor, 'projects', [binding.projectKey]);
    requireThat(p[1].toLowerCase() === binding.target.toLowerCase() && p[0].toLowerCase() === binding.owner.toLowerCase(), 'project_binding_changed');
    const [version, implementation, codeHash, clausGeneration, pendingSigner, pendingOwner] = await Promise.all([
      read(binding.target, 'version', [], targetAbi), read(binding.target, 'implementation', [], targetAbi),
      read(binding.target, 'implementationCodeHash', [], targetAbi), read(binding.executor, 'clausGeneration'),
      read(binding.executor, 'pendingSigner'), read(binding.executor, 'pendingProjectOwners', [binding.projectKey])
    ]);
    requireThat(p[7] && /^0x0{40}$/i.test(pendingSigner) && /^0x0{40}$/i.test(pendingOwner), 'project_suspended');
    return { owner: p[0], target: p[1], mandateHash: p[2], policyVersion: p[3], minDelaySeconds: Number(p[4]),
      policyGeneration: Number(p[5]), authorityGeneration: Number(p[6]), version: Number(version),
      implementation, codeHash, clausGeneration: Number(clausGeneration) };
  }
  async function moduleMatches(module) {
    requireThat(module.state === 'verified' && module.chainId === chainId && (module.profile ?? PROFILE) === profile &&
      keccak256(await client.getCode({ address: module.address })) === module.codeHash, 'module_code_changed');
  }
  return {
    validateModule: moduleValidator, state, capabilityMatches, validateBuildEvidence,
    async captureEvidence(input) {
      const snapshot = await evidence.capture(input);
      if (managed) {
        requireThat(!input.consumer, 'managed_consumer_unsupported');
        snapshot.managed = await captureManagedState({ client, snapshot, ...input });
      }
      return snapshot;
    },
    async registration({ projectId, owner, module, configuration, mandateHash, minDelaySeconds, capability, expiresAt }) {
      await capabilityMatches(capability); await moduleMatches(module);
      requireThat(/^0x(?:[a-f0-9]{2}){0,8192}$/i.test(configuration) && Number.isSafeInteger(minDelaySeconds) &&
        minDelaySeconds >= 0 && minDelaySeconds <= 5 * 86400, 'invalid_registration');
      // Read the actual pinned executor: older deployments still enforce an
      // hour. Never prepare an owner signature for a registration it rejects.
      const minimum = await read(capability.executor, 'MIN_UPGRADE_DELAY');
      requireThat(minimum >= 0n && minimum <= BigInt(minDelaySeconds), 'executor_delay_required');
      const salt = keccak256(stringToHex(projectId));
      const projectKey = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [owner, salt]));
      const message = { projectId: projectKey, owner, salt, implementation: module.address, codeHash: module.codeHash,
        initCallHash: keccak256(configuration), mandateHash, policyVersion: '0x' + digest({ profile, version: 1 }).slice(7),
        minDelaySeconds, nonce: BigInt('0x' + digest({ projectId, module: module.id, configuration, expiresAt }).slice(7)).toString(), expiresAt };
      return { profile, chainId: chainId, executor: capability.executor, configuration, observedBlock: String(await client.getBlockNumber()),
        domain: domain(capability.executor, chainId, profile), types: registrationTypes, primaryType: 'Registration', message };
    },
    async verifyRegistration(prepared, signature) {
      requireThat(prepared.profile === profile && digest(prepared.domain) === digest(domain(prepared.executor, chainId, profile)), 'registration_profile_mismatch');
      return verifyTypedData({ address: prepared.message.owner, domain: prepared.domain,
        types: registrationTypes, primaryType: 'Registration', message: prepared.message, signature });
    },
    async proposal({ binding, module, configuration, dependencySnapshot, nonceSeed, now }) {
      await moduleMatches(module); const s = await state(binding);
      requireThat(dependencySnapshot?.implementation?.codeHash === module.codeHash, 'dependency_evidence_mismatch');
      requireThat(s.minDelaySeconds <= 5 * 86400, 'unsupported_delay');
      requireThat(/^0x(?:[a-f0-9]{2}){0,8192}$/i.test(configuration), 'invalid_configuration');
      const proposal = { profile, chainId: chainId, executor: binding.executor, projectKey: binding.projectKey,
        target: binding.target, fromVersion: s.version, fromCodeHash: s.codeHash, implementation: module.address,
        toCodeHash: module.codeHash, configuration, dependencySnapshotHash: '0x' + digest(dependencySnapshot).slice(7),
        policyVersion: s.policyVersion, policyGeneration: s.policyGeneration, authorityGeneration: s.authorityGeneration,
        clausGeneration: s.clausGeneration, mandateHash: s.mandateHash, nonce: BigInt('0x' + digest(nonceSeed).slice(7)).toString(),
        notBefore: now, expiresAt: now + Math.max(86400, s.minDelaySeconds + 7200) };
      if (managed) assertManagedSnapshot(dependencySnapshot, proposal, binding);
      return proposal;
    },
    async validateProposal(proposal, binding, snapshot) {
      requireThat(proposal.profile === profile && proposal.chainId === chainId &&
        proposal.executor.toLowerCase() === binding.executor.toLowerCase() && proposal.projectKey === binding.projectKey, 'proposal_mismatch');
      const s = await state(binding);
      requireThat(proposal.fromVersion === s.version && proposal.fromCodeHash === s.codeHash && proposal.mandateHash === s.mandateHash &&
        proposal.policyVersion === s.policyVersion && proposal.policyGeneration === s.policyGeneration &&
        proposal.authorityGeneration === s.authorityGeneration && proposal.clausGeneration === s.clausGeneration &&
        keccak256(await client.getCode({ address: proposal.implementation })) === proposal.toCodeHash, 'proposal_stale');
      await evidence.validate(snapshot, proposal);
      if (managed) await validateManagedState({ client, snapshot, proposal, binding });
      return s;
    }
  };
}
