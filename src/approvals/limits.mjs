import { digest } from '../shared/index.mjs';

// Public requests spend the operator's existing model budget. These admission
// ceilings only narrow it; they do not fund or replenish that separate budget.
export const PUBLIC_DECISION_LIMITS = { projectDay: 2, globalDay: 8, projectLifetime: 4, globalLifetime: 32 };
export async function publicDecisionCapacity(reader, projectId, now, reserve = false) {
  const pilot = (await reader.read('review-pilots', projectId))?.value;
  if (!await reader.read('public-chain-projects', projectId) && pilot?.enabled && pilot.expiresAt > now) return false;
  const day = Math.floor(now / 86400000);
  // Operator-only, expiring allocations can fund a bounded recovery attempt.
  // Counts are never reset. Global caps and the separate model budget still bind.
  const allocation = (await reader.read('public-decision-allocations', digest({ projectId, day })))?.value;
  const requestedLifetime = Object.hasOwn(allocation ?? {}, 'maximumProjectLifetime')
    ? allocation.maximumProjectLifetime : PUBLIC_DECISION_LIMITS.projectLifetime;
  const allocated = allocation?.projectId === projectId && allocation.day === day &&
    Number.isSafeInteger(allocation.expiresAt) && allocation.expiresAt > now && allocation.expiresAt <= (day + 1) * 86400000 &&
    Number.isSafeInteger(requestedLifetime) && requestedLifetime >= PUBLIC_DECISION_LIMITS.projectLifetime && requestedLifetime <= 8 &&
    Number.isSafeInteger(allocation.maximumProjectDay) && allocation.maximumProjectDay >= PUBLIC_DECISION_LIMITS.projectDay &&
    allocation.maximumProjectDay <= requestedLifetime;
  const projectDay = allocated ? allocation.maximumProjectDay : PUBLIC_DECISION_LIMITS.projectDay;
  const projectLifetime = allocated ? requestedLifetime : PUBLIC_DECISION_LIMITS.projectLifetime;
  let canRetryNextDay = true;
  for (const [scope, subject, period, maximum] of [
    ['lifetime', projectId, null, projectLifetime],
    ['lifetime', 'global', null, PUBLIC_DECISION_LIMITS.globalLifetime],
    ['day', projectId, day, projectDay],
    ['day', 'global', day, PUBLIC_DECISION_LIMITS.globalDay]
  ]) {
    const key = digest({ scope, subject, period }), row = await reader.read('public-decision-admission', key);
    if (scope === 'lifetime' && subject === projectId)
      canRetryNextDay = (row?.value.count ?? 0) < PUBLIC_DECISION_LIMITS.projectLifetime;
    if ((row?.value.count ?? 0) >= maximum) throw Object.assign(new Error('decision_capacity_reached'),
      { code: 'decision_capacity_reached', ...(scope === 'day' && canRetryNextDay ? { retryAt: (day + 1) * 86400000 } : {}) });
    if (reserve) await reader.write('public-decision-admission', key, { count: (row?.value.count ?? 0) + 1 }, row?.revision ?? 0);
  }
  return true;
}
