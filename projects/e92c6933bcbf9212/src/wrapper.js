// Agent payment wrapper: assess the counterparty first, then check the scoped
// function-call key permits the exact action, and only then sign.
// Order: counterparty verdict -> key scope pre-check -> sign.
import { assess } from './check.js';
import { keyPermits } from './scopedkey.js';

export function scopedSigner({ receiverId, methodNames = [] }) {
  const scope = { receiverId, methodNames };
  return {
    scope,
    sign(action) {
      // Defence in depth: the signer re-checks even if a caller skipped guardedPay.
      const p = keyPermits(scope, { receiverId: action.receiverId, methodName: action.method, depositYocto: action.depositYocto ?? '0' });
      if (!p.ok) throw new Error(`key_scope: ${p.reason}`);
      return { signed: true, action };
    }
  };
}

export function guardedPay({ facts, signer, action, log, opts }) {
  const verdict = assess(facts, opts);
  const entry = { at: new Date().toISOString(), receiver: facts.accountId, amount: facts.amount, ...verdict };
  if (verdict.decision === 'block') {
    log.push({ ...entry, outcome: 'refused_to_sign' });
    return { ok: false, verdict };
  }
  if (verdict.decision === 'warn' && opts?.requireHumanOnWarn) {
    log.push({ ...entry, outcome: 'held_for_human' });
    return { ok: false, verdict };
  }
  const permit = keyPermits(signer.scope, { receiverId: action.receiverId, methodName: action.method, depositYocto: action.depositYocto ?? '0' });
  if (!permit.ok) {
    log.push({ ...entry, outcome: 'key_scope_refused', reason: permit.reason });
    return { ok: false, verdict, error: permit.reason };
  }
  const sig = signer.sign(action);
  log.push({ ...entry, outcome: 'signed' });
  return { ok: true, verdict, sig };
}
