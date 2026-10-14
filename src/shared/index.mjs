import { createHash } from 'node:crypto';

export const SITE_LIMITS = Object.freeze({ files:256, fileBytes:1000000, totalBytes:3000000, requestBytes:3200000 });
export const sitePublicationActive = (expiresAt, now) => expiresAt === null || Number.isSafeInteger(expiresAt) && expiresAt > now;
export const documentByteLimit = collection => collection === 'artifacts' ? 3100000 :
  ['snapshots','public-sources'].includes(collection) ? 131072 : collection === 'chain-transactions' ? 393216 : 65536;

export function requireThat(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

export function text(value, code = 'invalid_identifier') {
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u001f]/.test(value), code);
  return value;
}

export function sourcePath(value) {
  requireThat(typeof value === 'string' && value.length <= 180 &&
    /^[a-zA-Z0-9_.@+/-]+$/.test(value) &&
    value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..'), 'invalid_file_path');
  return value;
}

export function sourceText(value, maximum = 48000) {
  requireThat(typeof value === 'string' && value.isWellFormed() && value.length <= maximum &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), 'invalid_text');
  return value;
}

export function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  requireThat(Number.isSafeInteger(value) && value >= min && value <= max, 'invalid_integer');
  return value;
}

// Explicit null is reserved for continuing operator policies and budgets.
// User credentials, signed grants and individual transactions keep deadlines.
export function operatingExpiry(value) {
  return value === null ? null : integer(value, 1);
}
export function operatingWindowOpen(value, now) {
  return value === null || Number.isSafeInteger(value) && value > now;
}

export function amount(value) {
  requireThat(typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value), 'invalid_amount');
  const n = BigInt(value);
  requireThat(n < 2n ** 256n, 'invalid_amount');
  return n;
}

export function shape(value, keys) {
  requireThat(value !== null && typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key)), 'invalid_shape');
}

export function canonical(value, depth = 0) {
  requireThat(depth < 32, 'value_too_deep');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return String(integer(value));
  if (Array.isArray(value)) {
    requireThat(value.length <= 1000, 'value_too_large');
    return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']';
  }
  requireThat(value && Object.getPrototypeOf(value) === Object.prototype, 'invalid_json');
  const keys = Object.keys(value).sort();
  requireThat(keys.length <= 1000, 'value_too_large');
  requireThat(!keys.some(key => ['__proto__', 'constructor', 'prototype'].includes(key)), 'invalid_json_key');
  return '{' + keys.map(key => JSON.stringify(key) + ':' + canonical(value[key], depth + 1)).join(',') + '}';
}

export const copy = value => JSON.parse(canonical(value));
export const digest = value => 'sha256:' + createHash('sha256').update(canonical(value)).digest('hex');

export function contentHash(value) {
  requireThat(typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value), 'invalid_content_hash');
  return value;
}

export async function authorize(check, actor, action, scope = {}, reader) {
  requireThat(await check(actor, action, copy(scope), reader) === true, 'access_denied');
}
