import { createHash } from 'node:crypto';
import { canonical, digest, requireThat } from '../src/shared/index.mjs';

const sha256 = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const ORIGIN = 'https://api.programmable.market';
const CONTRACTS = { '3.6.0': 'https://programmable.market/openapi/custom-launch-v3.6.json' };
const equal = (a, b) => a !== undefined && b !== undefined && canonical(a) === canonical(b);
const permits = (rule, value) => rule?.const === value || rule?.enum?.includes(value) === true;

export function programmablePolicyHash(policy) {
  requireThat(policy?.schemaVersion === 'programmable.ethereum-programmable-trade-fee-policy.v1', 'invalid_programmable_policy');
  return sha256(policy.schemaVersion + '\0' + canonical(policy));
}

// This selects a documented provider contract, not permission to launch.
// readyz.apiContractSha256 commits the provider's internal route contract;
// it is NOT a hash of the public OpenAPI document. Those remain separate.
export function inspectProgrammableDiscovery({ capabilities, readiness, manifest, openapiBytes,
  releaseContractBytes, releaseSourceCommit }) {
  requireThat(capabilities?.profile && readiness?.publicProfile && typeof openapiBytes === 'string',
    'programmable_discovery_incomplete');
  const problems = [], warnings = [];
  const version = capabilities.profile.profileVersion;
  if (!CONTRACTS[version]) problems.push('unsupported_profile');
  if (version !== readiness.publicProfile.profileVersion || version !== readiness.publicProfile.currentWriteProfileVersion)
    problems.push('profile_version_mismatch');
  if (capabilities.profile.productionLaunchAuthorized !== true || readiness.publicProfile.productionLaunchAuthorized !== true ||
    readiness.status !== 'ready') problems.push('profile_not_ready');
  if (!capabilities.requestProfiles?.freshSubmissionExactVersions?.includes(version)) problems.push('fresh_profile_not_admitted');
  let schema;
  try { schema = JSON.parse(openapiBytes); } catch { problems.push('invalid_api_contract'); }
  const availability = schema?.['x-programmable-availability'];
  if (schema && (schema.info?.version !== version || availability?.profileVersion !== version ||
    availability?.openApiUrl !== CONTRACTS[version] || availability?.capabilitiesUrl !== ORIGIN + '/v3/capabilities' ||
    !schema.servers?.some(server => server.url === ORIGIN) || !schema.paths?.['/v3/custom-launches']?.post))
    problems.push('api_contract_version_mismatch');
  const chain = readiness.chain ?? {}, properties = schema?.components?.schemas?.DirectNativeHookGraphProfileV1?.properties;
  if (chain.chainId !== '1') problems.push('invalid_chain_identity');
  for (const name of ['router', 'graphFactory', 'poolManager', 'permitAuthority']) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(chain[name] ?? '') || !/^0x[0-9a-fA-F]{64}$/.test(chain[name + 'RuntimeCodeHash'] ?? '') ||
      !permits(properties?.[name], chain[name]) || !permits(properties?.[name + 'RuntimeCodeHash'], chain[name + 'RuntimeCodeHash']))
      problems.push(name + '_identity_mismatch');
  }
  const routerBindings = schema?.components?.schemas?.DirectNativeHookGraphProfileV1?.allOf ?? [];
  if (!routerBindings.some(rule => rule.if?.properties?.router?.const === chain.router &&
    rule.then?.properties?.routerRuntimeCodeHash?.const === chain.routerRuntimeCodeHash)) problems.push('router_binding_missing');
  const artifactHash = capabilities.profile36Release?.profileArtifactSha256;
  if (!/^sha256:[0-9a-f]{64}$/.test(artifactHash ?? '') || artifactHash !== readiness.publicProfile.profileSha256)
    problems.push('profile_artifact_mismatch');
  const policy = capabilities.programmableTradeFeePolicy?.policy, policyHash = capabilities.programmableTradeFeePolicy?.policyHash;
  let actualPolicyHash;
  try { actualPolicyHash = programmablePolicyHash(policy); } catch { /* Invalid policy stays blocked. */ }
  if (!policyHash || actualPolicyHash !== policyHash || policyHash !== readiness.programmableTradeFeePolicy?.policyHash ||
    !equal(policy, readiness.programmableTradeFeePolicy?.policy)) problems.push('trade_fee_policy_mismatch');
  const rules = schema?.components?.schemas?.ProgrammableTradeFeePolicyV36;
  if (!equal(rules?.const, policy) && !rules?.oneOf?.some(rule => equal(rule.const, policy)))
    problems.push('trade_fee_policy_undocumented');
  let releaseContractVerified = false;
  if (releaseContractBytes !== undefined) {
    try { releaseContractVerified = releaseSourceCommit === readiness.sourceCommit &&
      sha256(JSON.stringify(JSON.parse(releaseContractBytes), null, 2) + '\n') === readiness.apiContractSha256; } catch { /* Block below. */ }
    if (!releaseContractVerified) problems.push('release_contract_hash_mismatch');
  }
  const descriptorVersion = manifest?.directNativeHookGraphProfileV3?.profileVersion;
  if (descriptorVersion && descriptorVersion !== version) warnings.push('legacy_manifest_not_used_for_current_profile');
  const evidence = { apiProfile: version, publicApiContractUrl: CONTRACTS[version] ?? null,
    publicApiContractHash: sha256(openapiBytes), runtimeApiContractHash: readiness.apiContractSha256 ?? null,
    sourceCommit: readiness.sourceCommit ?? null, profileArtifactHash: artifactHash ?? null,
    chain, policyHash: policyHash ?? null, policy: policy ?? null };
  return { state: problems.length ? 'incompatible' : 'discovered', problems, warnings, evidence,
    discoveryHash: digest(evidence), releaseContractVerified, chainRuntimeVerified: false, launchAuthorized: false };
}

export async function readProgrammableDiscovery({ fetchImpl = fetch } = {}) {
  async function get(url) {
    const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { accept: 'application/json' } });
    requireThat(response.ok, 'programmable_discovery_unavailable');
    const body = await response.text(); requireThat(Buffer.byteLength(body) <= 2000000, 'programmable_discovery_too_large');
    return body;
  }
  const [capabilities, readiness] = await Promise.all([
    ORIGIN + '/v3/capabilities', ORIGIN + '/readyz'
  ].map(async url => JSON.parse(await get(url))));
  const url = CONTRACTS[capabilities.profile?.profileVersion];
  requireThat(url, 'unsupported_programmable_profile');
  const openapiBytes = await get(url);
  return { ...inspectProgrammableDiscovery({ capabilities, readiness, openapiBytes }), observedAt: new Date().toISOString() };
}
