import { digest, requireThat } from '../shared/index.mjs';

// Public requests spend the operator's existing model budget. These admission
// ceilings only narrow it; they do not fund or replenish that separate budget.
export const PUBLIC_DECISION_LIMITS = { projectDay: 2, globalDay: 8, projectLifetime: 4, globalLifetime: 32 };
export async function publicDecisionCapacity(reader, projectId, now, reserve = false) {
  if (!await reader.read('public-chain-projects', projectId)) return;
  const day = Math.floor(now / 86400000);
  for (const [scope, subject, period, maximum] of [
    ['day', projectId, day, PUBLIC_DECISION_LIMITS.projectDay],
    ['day', 'global', day, PUBLIC_DECISION_LIMITS.globalDay],
    ['lifetime', projectId, null, PUBLIC_DECISION_LIMITS.projectLifetime],
    ['lifetime', 'global', null, PUBLIC_DECISION_LIMITS.globalLifetime]
  ]) {
    const key = digest({ scope, subject, period }), row = await reader.read('public-decision-admission', key);
    requireThat((row?.value.count ?? 0) < maximum, 'decision_capacity_reached');
    if (reserve) await reader.write('public-decision-admission', key, { count: (row?.value.count ?? 0) + 1 }, row?.revision ?? 0);
  }
}
