import {createHash} from 'node:crypto';

// A caller may lower the configured ceiling, never raise it. Bind that ceiling
// to the idempotency key so a retry cannot silently increase an old allowance.
export function requestBudget(body, ceiling, requested, reservation) {
  if (requested !== undefined && !/^[1-9]\d{0,23}$/.test(requested)) throw Error('invalid_request_budget');
  if (reservation !== undefined && reservation !== 'quoted-v1') throw Error('invalid_request_budget');
  const cap = requested === undefined ? ceiling : BigInt(requested);
  const identity = requested === undefined ? body : `${requested}\n${body}`;
  return {
    maximum: cap < ceiling ? cap : ceiling,
    hash: createHash('sha256').update(reservation === undefined ? identity : `${reservation}\n${identity}`).digest('hex'),
  };
}
