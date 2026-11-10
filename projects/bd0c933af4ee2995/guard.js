// Payer guard: refuse to pay/hire a NEAR account whose sampled inflows mostly trace back to itself.
// Read-only. Unknown is NOT treated as safe or unsafe: caller decides via opts.onUnknown.
import { check } from './check.js';

export function decide(result, opts = {}) {
  const onUnknown = opts.onUnknown || 'warn';
  const v = String(result?.verdict || 'unknown: no verdict');
  if (v.startsWith('mostly self-funded')) return { allow: false, reason: 'refuse: ' + v, verdict: v };
  if (v.startsWith('unknown')) return { allow: onUnknown === 'allow', reason: (onUnknown === 'allow' ? 'allow' : 'hold') + ' (unknown): ' + v, verdict: v };
  return { allow: true, reason: 'allow: ' + v, verdict: v };
}

export async function guard(account, opts = {}) {
  const result = await check(account);
  return { account, ...decide(result, opts) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const acct = process.argv[2];
  if (!acct) { console.error('usage: node guard.js <account.near>'); process.exit(2); }
  const g = await guard(acct);
  console.log(JSON.stringify(g, null, 2));
  process.exit(g.allow ? 0 : 1);
}
