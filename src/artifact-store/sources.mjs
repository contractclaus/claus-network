import {createHash} from 'node:crypto';
import {digest, requireThat, SITE_LIMITS} from '../shared/index.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const SOURCE_INLINE_BYTES = 4096;

// Authorization belongs to the caller. The physical object key never comes
// from a client, and every read binds both its bytes and its logical file hash.
export function createSourceFiles({store, objects = null, now = Date.now}) {
  const cache = new Map(), pending = new Map();
  let cacheBytes = 0;
  const cacheLimit = 8 * 1024 * 1024;
  function remember(key, content) {
    const bytes = Buffer.byteLength(content);
    if (cache.has(key)) { cacheBytes -= cache.get(key).bytes; cache.delete(key); }
    cache.set(key, {content, bytes, expiresAt: now() + 300000}); cacheBytes += bytes;
    while (cacheBytes > cacheLimit || cache.size > 128) {
      const first = cache.keys().next().value;
      cacheBytes -= cache.get(first).bytes; cache.delete(first);
    }
  }
  function checked(value, content) {
    requireThat(typeof content === 'string' && Buffer.byteLength(content) <= SITE_LIMITS.fileBytes &&
      digest({path:value.path, content}) === value.hash, 'artifact_corrupt');
    return {projectId:value.projectId, path:value.path, content, hash:value.hash};
  }
  async function resolve(value) {
    requireThat(value && typeof value.projectId === 'string', 'not_found');
    if (typeof value.content === 'string') return checked(value, value.content);
    const ref = value.object;
    requireThat(ref?.kind === 'r2-source-v1' && /^[a-f0-9]{64}$/.test(ref.sha256) &&
      Number.isSafeInteger(ref.bytes) && ref.bytes > SOURCE_INLINE_BYTES &&
      ref.bytes <= SITE_LIMITS.fileBytes, 'artifact_corrupt');
    requireThat(objects, 'source_storage_unavailable');
    const key = value.projectId + ':' + ref.sha256;
    const hit = cache.get(key);
    if (hit?.expiresAt > now()) {
      requireThat(hit.bytes === ref.bytes, 'artifact_corrupt');
      return checked(value, hit.content);
    }
    if (!pending.has(key)) {
      const read = (async () => {
        const found = await objects.read(value.projectId, ref.sha256);
        requireThat(found.state === 'verified' && found.length === ref.bytes &&
          sha(found.bytes) === ref.sha256, 'artifact_corrupt');
        const content = new TextDecoder('utf-8', {fatal:true}).decode(found.bytes);
        checked(value, content); remember(key, content); return content;
      })();
      pending.set(key, read);
    }
    try {
      const content = await pending.get(key);
      requireThat(Buffer.byteLength(content) === ref.bytes, 'artifact_corrupt');
      return checked(value, content);
    }
    finally { pending.delete(key); }
  }
  async function prepare(projectId, file) {
    const value = checked({...file, projectId}, file.content);
    const bytes = Buffer.from(value.content);
    if (!objects || bytes.length <= SOURCE_INLINE_BYTES) return value;
    const hash = sha(bytes), key = projectId + ':' + hash;
    const saved = await objects.put(projectId, bytes);
    requireThat(saved.state === 'verified' && saved.sha256 === hash && saved.bytes === bytes.length, 'artifact_corrupt');
    remember(key, value.content);
    return {projectId, path:value.path, hash:value.hash,
      object:{kind:'r2-source-v1', sha256:hash, bytes:bytes.length}};
  }
  return {
    enabled: Boolean(objects), resolve, prepare,
    async get(projectId, hash, reader = store) {
      const value = (await reader.read('artifacts', digest({projectId, id:hash})))?.value;
      requireThat(value?.projectId === projectId && value.hash === hash, 'not_found');
      return resolve(value);
    }
  };
}
