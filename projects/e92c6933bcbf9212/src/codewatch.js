// Records each account's contract code_hash and reports a change against the stored value.
import fs from 'fs';
export const EMPTY = '11111111111111111111111111111111';
export function load(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } }
export function observe(store, accountId, codeHash, at = new Date().toISOString()) {
  const prev = store[accountId];
  const hasCode = !!codeHash && codeHash !== EMPTY;
  let change = 'first_seen';
  if (prev) change = prev.codeHash === codeHash ? 'unchanged' : 'changed';
  store[accountId] = { codeHash, hasCode, firstSeen: prev ? prev.firstSeen : at, lastChange: change === 'changed' ? at : (prev ? prev.lastChange : null) };
  return { change, hasCode, previous: prev ? prev.codeHash : null };
}
export function save(file, store) { fs.writeFileSync(file, JSON.stringify(store, null, 2)); }
