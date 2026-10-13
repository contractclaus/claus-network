import { requireThat } from '../shared/index.mjs';

export const READONLY_PROFILE = 'claus-readonly-v1';
export const MANAGED_PROFILE = 'claus-managed-v1';

export function assertReviewProfile(review, { chainId, profile = READONLY_PROFILE }) {
  requireThat((review.profile ?? READONLY_PROFILE) === profile, 'project_profile_mismatch');
  // Historical readonly source reviews did not select a chain. Managed
  // reviews must name one; never reinterpret an explicitly scoped review.
  requireThat(review.chainId === chainId || review.chainId === undefined && profile === READONLY_PROFILE,
    'project_chain_mismatch');
}

// Legacy keys and absent profile fields belong to readonly. Adding a profile
// must never repoint an existing project or spend another profile's allocation.
export function chainProfile(chainId = 11155111, profile = READONLY_PROFILE) {
  requireThat([1, 11155111].includes(chainId), 'unsupported_chain');
  requireThat([READONLY_PROFILE, MANAGED_PROFILE].includes(profile), 'unsupported_profile');
  const managed = profile === MANAGED_PROFILE;
  return { chainId, profile,
    capability: managed ? `chain:${chainId}:managed` : chainId === 1 ? 'chain:1' : 'chain',
    policy: managed ? `chain.${chainId}.managed.admission` : chainId === 1 ? 'chain.mainnet.admission' : 'chain.admission',
    usage: managed ? `managed:${chainId}` : chainId === 1 ? 'mainnet' : 'global',
    assessment: managed ? { chainId, profile } : chainId === 1 ? { chainId } : {}
  };
}

export async function projectProfile(reader, projectId, requested = {}) {
  if (requested.chainId !== undefined) chainProfile(requested.chainId);
  if (requested.profile !== undefined) chainProfile(11155111, requested.profile);
  const records = await Promise.all(['chain-project-profiles', 'chain-bindings', 'public-chain-projects']
    .map(collection => reader.read(collection, projectId)));
  let selected;
  for (const row of records) {
    if (!row) continue;
    const value = chainProfile(row.value.chainId ?? 11155111, row.value.profile ?? READONLY_PROFILE);
    requireThat(!selected || selected.chainId === value.chainId && selected.profile === value.profile, 'project_profile_mismatch');
    selected = value;
  }
  if (!selected) {
    // Older module jobs predate the binding collection. They are authoritative
    // too; a pending deployment cannot be converted by a later API request.
    const modules = await reader.list('chain-modules', { projectId, limit: 1 });
    if (modules.length) selected = chainProfile(modules[0].value.chainId ?? 11155111, modules[0].value.profile ?? READONLY_PROFILE);
  }
  if (selected) {
    requireThat(requested.chainId === undefined || selected.chainId === requested.chainId, 'project_chain_mismatch');
    requireThat(requested.profile === undefined || selected.profile === requested.profile, 'project_profile_mismatch');
    return selected;
  }
  return chainProfile(requested.chainId, requested.profile);
}
