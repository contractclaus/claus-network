import { keccak256 } from 'viem';
import { digest, requireThat } from '../src/shared/index.mjs';
import { MANAGED_PROFILE } from '../src/chain-deployments/profiles.mjs';
import { ClausManagedExecutorAbi, ClausManagedProjectAbi } from './managed-abi.mjs';
import { validateBuildEvidence, inspectCode } from './chain-evidence.mjs';
import { validateManagedModule } from './managed-module.mjs';

export async function captureManagedState({ client, snapshot, binding, capability, previous }) {
  requireThat(binding?.profile === MANAGED_PROFILE && capability?.profile === MANAGED_PROFILE &&
    capability.executor.toLowerCase() === binding.executor.toLowerCase(), 'managed_binding_missing');
  const blockNumber = BigInt(snapshot.blockNumber);
  const read = (address, functionName, args = [], abi = ClausManagedExecutorAbi) =>
    client.readContract({ address, abi, functionName, args, blockNumber });
  const [module, initial, registryCode, targetCode, actualExecutor, actualId] = await Promise.all([
    read(binding.executor, 'moduleState', [binding.projectKey]),
    read(binding.executor, 'initialModules', [binding.projectKey]),
    client.getCode({ address: binding.executor, blockNumber }), client.getCode({ address: binding.target, blockNumber }),
    read(binding.target, 'executor', [], ClausManagedProjectAbi), read(binding.target, 'projectId', [], ClausManagedProjectAbi)
  ]);
  requireThat(registryCode && targetCode && keccak256(registryCode) === capability.executorCodeHash &&
    keccak256(targetCode) === binding.codeHash && actualExecutor.toLowerCase() === binding.executor.toLowerCase() &&
    actualId === binding.projectKey, 'managed_registry_changed');
  const version = Number(module[2]);
  requireThat(Number.isSafeInteger(version) && version >= 0, 'managed_version_invalid');
  let prior = null;
  if (version > 0) {
    requireThat(previous?.build && previous?.source, 'managed_previous_source_missing');
    const code = await client.getCode({ address: module[0], blockNumber });
    requireThat(code && keccak256(code) === module[1], 'managed_previous_code_changed');
    inspectCode(code); validateManagedModule(previous.build);
    validateBuildEvidence(previous.build, previous.source, { code, codeHash: module[1] });
    prior = { ...previous, implementation: module[0], code, codeHash: module[1] };
  } else requireThat(/^0x0{40}$/i.test(module[0]) && /^0x0{64}$/i.test(module[1]) && !previous, 'managed_state_invalid');
  return { profile: MANAGED_PROFILE, target: binding.target, targetCodeHash: binding.codeHash,
    registry: binding.executor, registryCodeHash: capability.executorCodeHash, projectKey: binding.projectKey,
    version, implementation: module[0], codeHash: module[1], configuration: module[3],
    initial: { implementation: initial[0], codeHash: initial[1], initCallHash: initial[2], createdAtBlock: initial[3].toString() },
    previous: prior };
}

export function assertManagedSnapshot(snapshot, proposal, binding) {
  const m = snapshot?.managed;
  requireThat(m?.profile === MANAGED_PROFILE && m.version === proposal.fromVersion && m.codeHash === proposal.fromCodeHash &&
    m.projectKey === proposal.projectKey && m.registry.toLowerCase() === proposal.executor.toLowerCase() &&
    m.target.toLowerCase() === proposal.target.toLowerCase() && m.targetCodeHash === binding.codeHash, 'managed_evidence_mismatch');
  if (m.version === 0) requireThat(m.initial.implementation.toLowerCase() === proposal.implementation.toLowerCase() &&
    m.initial.codeHash === proposal.toCodeHash && m.initial.initCallHash === keccak256(proposal.configuration) &&
    BigInt(snapshot.blockNumber) >= BigInt(m.initial.createdAtBlock), 'managed_initial_mismatch');
  else requireThat(m.previous?.codeHash === proposal.fromCodeHash &&
    digest(m.previous.build) === m.previous.source.buildHash, 'managed_previous_source_missing');
}

export async function validateManagedState({ client, snapshot, proposal, binding }) {
  assertManagedSnapshot(snapshot, proposal, binding);
  const m = snapshot.managed;
  const [registryCode, targetCode, initial] = await Promise.all([
    client.getCode({ address: m.registry }), client.getCode({ address: m.target }),
    client.readContract({ address: m.registry, abi: ClausManagedExecutorAbi, functionName: 'initialModules', args: [m.projectKey] })
  ]);
  requireThat(registryCode && targetCode && keccak256(registryCode) === m.registryCodeHash &&
    keccak256(targetCode) === m.targetCodeHash && initial[0].toLowerCase() === m.initial.implementation.toLowerCase() &&
    initial[1] === m.initial.codeHash && initial[2] === m.initial.initCallHash && initial[3].toString() === m.initial.createdAtBlock,
    'managed_registry_changed');
}
