import { canonical, digest, requireThat, text } from '../shared/index.mjs';

// Private content-addressed artifacts. Each document stays below the store's
// 64 KiB ceiling; publication is a separate capability.
export function createArtifactStore({ store }) {
  return {
    async put(tx, projectId, value) {
      text(projectId);
      const raw = Buffer.from(canonical(value));
      requireThat(raw.length <= 4000000, 'artifact_too_large');
      const hash = digest(value), id = digest({ projectId, hash });
      if (await tx.read('artifact-manifests', id)) return hash;
      const chunks = [];
      for (let offset = 0; offset < raw.length; offset += 32000) {
        const data = raw.subarray(offset, offset + 32000).toString('base64');
        const key = digest({ projectId, data }); chunks.push(key);
        if (!await tx.read('artifact-chunks', key)) await tx.write('artifact-chunks', key, { data }, 0);
      }
      await tx.write('artifact-manifests', id, { projectId, hash, bytes: raw.length, chunks }, 0);
      return hash;
    },
    async get(projectId, hash, reader = store) {
      const value = (await reader.read('artifact-manifests', digest({ projectId, hash })))?.value;
      requireThat(value?.projectId === projectId, 'not_found');
      const chunks = [];
      for(let i=0;i<value.chunks.length;i+=8){
        chunks.push(...await Promise.all(value.chunks.slice(i,i+8).map(async key=>{
          const chunk=(await reader.read('artifact-chunks',key))?.value;
          requireThat(chunk&&digest({projectId,data:chunk.data})===key,'artifact_corrupt');
          return Buffer.from(chunk.data,'base64');
        })));
      }
      const raw = Buffer.concat(chunks); requireThat(raw.length === value.bytes, 'artifact_corrupt');
      const result = JSON.parse(raw.toString('utf8'));
      requireThat(digest(result) === hash, 'artifact_corrupt');
      return result;
    }
  };
}
