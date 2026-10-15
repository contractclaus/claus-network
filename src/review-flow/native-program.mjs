import { requireThat } from '../shared/index.mjs';

export const NATIVE_PROGRAM_PROFILE = 'claus-native-program-v1';
export const NATIVE_PROGRAM_OWNER = '0x59edf6152080e847e5ea15f9ae6a77c1f03c44f5';

// This is review admission only. It deliberately does not extend chainProfile,
// deployment admission or any public transaction/signature capability.
export async function selectNativeProgramReview({ reader, identity, projectId, actor, chainId }) {
  requireThat(chainId === 1, 'unsupported_chain');
  const credential = await identity.credential(actor, reader);
  const [principal, project, capability] = await Promise.all([
    reader.read('principals', credential.principalId), reader.read('projects', projectId),
    reader.read('network-capabilities', 'native-program-review')
  ]);
  requireThat(credential.kind === 'owner' && principal?.value.chainId === 1 &&
    principal.value.address?.toLowerCase() === NATIVE_PROGRAM_OWNER &&
    project?.value.ownerId === credential.principalId && !project.value.archivedAt, 'scope_denied');
  requireThat(capability?.value.enabled === true, 'native_program_review_not_enabled');
  return { chainId: 1, profile: NATIVE_PROGRAM_PROFILE };
}
const types = fields => Array.isArray(fields) ? fields.map(f => f.type).join(',') : null;
export function validateNativeProgramBuild(artifact) {
  requireThat(artifact?.status === 'compiled' &&
    ['solidity-static-compile-v1', 'solidity-0.8.26-static-v1'].includes(artifact.profile?.profile) &&
    artifact.profile.evmVersion === 'cancun' && artifact.profile.viaIR === true &&
    artifact.profile.optimizerRuns === 200, 'native_program_compiler_invalid');
  requireThat(typeof artifact.creationBytecode === 'string' && /^0x(?:[0-9a-f]{2})+$/i.test(artifact.creationBytecode) &&
    artifact.creationBytecode.length <= 98306 &&
    typeof artifact.runtimeTemplate === 'string' && /^0x(?:[0-9a-f]{2})+$/i.test(artifact.runtimeTemplate) &&
    artifact.runtimeTemplate.length <= 49154 && Array.isArray(artifact.abi), 'native_program_artifact_invalid');
  const constructors = artifact.abi.filter(f => f.type === 'constructor');
  requireThat(constructors.length <= 1 && constructors.every(f => types(f.inputs) === ''), 'native_program_constructor_unsupported');
  const quotes = artifact.abi.filter(f => f.type === 'function' && f.name === 'quote');
  const deliveries = artifact.abi.filter(f => f.type === 'function' && f.name === 'onTrade');
  requireThat(quotes.length === 1 && ['view', 'pure'].includes(quotes[0].stateMutability) &&
    types(quotes[0].inputs) === 'address,bool,int256,uint160,uint128,bytes' &&
    types(quotes[0].outputs) === 'uint256[6]', 'native_program_quote_abi_invalid');
  requireThat(deliveries.length === 1 && deliveries[0].stateMutability === 'nonpayable' &&
    types(deliveries[0].inputs) === 'tuple,bytes' && types(deliveries[0].outputs) === 'bytes4' &&
    types(deliveries[0].inputs[0].components) === 'uint256,address,address,bool,int128,int128,uint256,uint256,uint256,uint256,bytes32',
    'native_program_delivery_abi_invalid');
  return { profile: NATIVE_PROGRAM_PROFILE, chainId: 1, evidenceLevel: 'interface_only',
    constructorArguments: [], installationAuthorized: false };
}
