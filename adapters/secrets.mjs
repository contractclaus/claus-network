import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { canonical, requireThat } from '../src/shared/index.mjs';

export function createSealer(hexKey) {
  requireThat(typeof hexKey === 'string' && /^[0-9a-f]{64}$/.test(hexKey), 'encryption_key_required');
  const key = Buffer.from(hexKey, 'hex');
  return {
    seal(context, value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(context));
      const data = Buffer.concat([cipher.update(canonical(value)), cipher.final()]);
      return { v: 1, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('base64') };
    },
    open(context, value) {
      try {
        requireThat(value?.v === 1 && /^[0-9a-f]{24}$/.test(value.iv) && /^[0-9a-f]{32}$/.test(value.tag), 'invalid_sealed_record');
        const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'hex'));
        cipher.setAAD(Buffer.from(context)); cipher.setAuthTag(Buffer.from(value.tag, 'hex'));
        return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.data, 'base64')), cipher.final()]).toString());
      } catch { throw Object.assign(Error('sealed_record_unavailable'), { code: 'sealed_record_unavailable' }); }
    }
  };
}
