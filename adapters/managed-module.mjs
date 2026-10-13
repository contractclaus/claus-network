import { keccak256, toFunctionSelector } from 'viem';
import { requireThat } from '../src/shared/index.mjs';
import { inspectCode } from './chain-evidence.mjs';

const reserved = new Set(['executor()', 'projectId()', 'implementation()', 'implementationCodeHash()',
  'version()', 'configuration()', 'initialize(bytes)'].map(toFunctionSelector));

export function validateManagedModule(artifact) {
  requireThat(artifact?.status === 'compiled' && artifact.profile?.profile === 'solidity-managed-compile-v1' && artifact.standardInput?.settings?.metadata?.appendCBOR === false &&
    Object.keys(artifact.immutableReferences ?? {}).length === 0 && /^0x[0-9a-f]+$/.test(artifact.creationBytecode) &&
    Array.isArray(artifact.abi) && artifact.storageLayout && Array.isArray(artifact.storageLayout.storage), 'unsupported_module');
  requireThat(artifact.abi.every(item => item.type !== 'constructor' || item.inputs.length === 0), 'unsupported_module');
  requireThat(artifact.abi.filter(item => item.type === 'function').every(item => !reserved.has(toFunctionSelector(item))),
    'reserved_module_selector');
  requireThat(keccak256(artifact.runtimeTemplate) === artifact.runtimeTemplateHash, 'artifact_corrupt');
  // Dynamic delegatecall, callcode and selfdestruct are not part of this first
  // managed profile. Ordinary state writes still require semantic review.
  inspectCode(artifact.runtimeTemplate);
}
