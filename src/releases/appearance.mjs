import {digest, sitePublicationActive} from '../shared/index.mjs';
import {presentation} from './presentation.mjs';

// Resolve the selected public manifests in fixed batches. Map discovery must
// not issue one HTTP request (and a full release lookup) for every project.
export function createPublicAppearances({store, visibleMany, now = Date.now}) {
  const many = async (collection, ids) => {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    return store.readMany ? store.readMany(collection, unique) :
      new Map(await Promise.all(unique.map(async id => [id, await store.read(collection, id)])));
  };
  return async ids => {
    if (!Array.isArray(ids) || ids.length > 100) throw Error('invalid_appearance_batch');
    const allowed = await visibleMany(ids);
    const visible = ids.filter(id => allowed.has(id));
    const [controls, selections] = await Promise.all([
      many('content-controls', visible), many('project-site-selection', visible)
    ]);
    const selected = visible.flatMap(projectId => {
      const releaseId = controls.get(projectId)?.value.releaseId ?? selections.get(projectId)?.value.releaseId;
      return /^sha256:[a-f0-9]{64}$/.test(releaseId ?? '') ? [{projectId, releaseId}] : [];
    });
    const [publications, releases] = await Promise.all([
      many('release-publications', selected.map(x => x.releaseId)),
      many('project-releases', selected.map(x => x.releaseId))
    ]);
    const current = selected.flatMap(item => {
      const publication = publications.get(item.releaseId)?.value, release = releases.get(item.releaseId)?.value;
      if (!publication?.published || publication.projectId !== item.projectId ||
        !sitePublicationActive(publication.expiresAt, now()) || release?.projectId !== item.projectId ||
        release.id !== item.releaseId || !release.snapshotId || !release.paths?.includes('claus.json')) return [];
      return [{...item, publication, release, snapshotKey:digest({projectId:item.projectId,id:release.snapshotId})}];
    });
    const snapshots = await many('snapshots', current.map(x => x.snapshotKey));
    const candidates = current.flatMap(item => {
      const snapshot = snapshots.get(item.snapshotKey)?.value;
      const file = snapshot?.projectId === item.projectId && snapshot.files?.find(f => f.path === 'claus.json');
      return file?.hash ? [{...item,file,artifactKey:digest({projectId:item.projectId,id:file.hash})}] : [];
    });
    const artifacts = await many('artifacts', candidates.map(x => x.artifactKey));
    const result = new Map();
    for (const item of candidates) {
      const file = artifacts.get(item.artifactKey)?.value;
      if (file?.projectId !== item.projectId || file.path !== 'claus.json' || file.hash !== item.file.hash ||
        typeof file.content !== 'string' || Buffer.byteLength(file.content) > 4096 ||
        !sitePublicationActive(item.publication.expiresAt, now())) continue;
      try {
        const value = presentation(JSON.parse(file.content), {...item.release, files:item.release.paths.map(path => ({path}))});
        if (value) result.set(item.projectId, value);
      } catch { /* Invalid public artwork must not remove a project from discovery. */ }
    }
    return result;
  };
}
