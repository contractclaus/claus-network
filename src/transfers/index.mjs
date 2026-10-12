import { canonical, digest, integer, requireThat, shape, text, sourcePath, sourceText } from '../shared/index.mjs';
import { verifyArchiveHeader, verifyProjectArchive } from '../portability/index.mjs';

const MAX_ARCHIVE = 3500000, MAX_HEADER = 48000;
const origin = value => {
  const url = new URL(value);
  requireThat(url.protocol === 'https:' && url.origin === value, 'invalid_operator'); return value;
};
const header = archive => ({ id: archive.id, manifest: archive.manifest, signature: archive.signature });

export function createProjectTransfers({ store, identity, artifacts, archives, operatorId, trustedOperators,
  consumeSnapshotBytes = async () => {}, limit = async () => undefined, admit = async () => {}, admitImport = async () => {}, now = () => Date.now() }) {
  async function owner(actor, reader = store) {
    const credential = await identity.credential(actor, reader);
    requireThat(credential.kind === 'owner', 'scope_denied');
    const principal = (await reader.read('principals', credential.principalId))?.value;
    requireThat(principal?.address, 'scope_denied');
    return { credential, principal };
  }
  function verify(header, principal) {
    requireThat(operatorId && trustedOperators, 'portability_not_enabled');
    const manifest = verifyArchiveHeader(header, { trustedOperators, expectedOwner: principal });
    requireThat(manifest.purpose === 'source-fenced-transfer' && manifest.transfer.destination === operatorId,
      'transfer_destination_mismatch');
    requireThat(manifest.contentBytes <= MAX_ARCHIVE && manifest.recordCount <= 2000 && Buffer.byteLength(canonical(header)) <= MAX_HEADER,
      'transfer_too_large');
    return manifest;
  }
  async function imported(actor, id, reader = store) {
    const { credential, principal } = await owner(actor, reader);
    const row = await reader.read('transfer-imports', text(id));
    requireThat(row?.value.ownerId === credential.principalId, 'not_found');
    verify(row.value.header, principal); return row;
  }
  const api = {
    async prepare(actor, projectId, { destination, expectedProjectRevision, idempotencyKey }) {
      requireThat(archives && operatorId, 'portability_not_enabled');
      origin(destination); requireThat(destination !== operatorId, 'invalid_transfer_destination');
      integer(expectedProjectRevision, 1); text(idempotencyKey);
      const id = digest({ projectId, destination, idempotencyKey, kind: 'project-transfer' });
      return store.transaction(async tx => {
        const { project } = await identity.owner(actor, projectId, tx);
        const existing = await tx.read('project-transfers', id);
        if (existing) return existing.value.header;
        await admit(projectId, tx);
        const current = await tx.read('projects', projectId);
        requireThat(current.revision === expectedProjectRevision && !project.transfer, 'transfer_conflict');
        const transfer = { id, destination, fencedAt: now() };
        await tx.write('projects', projectId, { ...project, transfer }, current.revision);
        await tx.event({ type: 'project.transfer_fenced', projectId, transferId: id, destination, at: now() });
        const archive = await archives.export(actor, projectId, { reader: tx, transfer });
        requireThat(archive.manifest.recordCount <= 2000 && Buffer.byteLength(canonical(archive)) <= MAX_ARCHIVE &&
          Buffer.byteLength(canonical(header(archive))) <= MAX_HEADER, 'transfer_too_large');
        const artifactHash = await artifacts.put(tx, projectId, archive);
        await tx.write('project-transfers', id, { projectId, header: header(archive), artifactHash }, 0);
        await tx.write('project-transfer-archives', archive.id, { projectId, transferId: id }, 0);
        return header(archive);
      });
    },
    async page(actor, projectId, { archiveId, page }) {
      await identity.authorize(actor, 'project.export', { projectId });
      const index = (await store.read('project-transfer-archives', text(archiveId)))?.value;
      requireThat(index?.projectId === projectId, 'not_found');
      const transfer = (await store.read('project-transfers', index.transferId)).value;
      const archive = await artifacts.get(projectId, transfer.artifactHash);
      integer(page, 0, archive.pages.length - 1); return archive.pages[page];
    },
    async beginImport(actor, input) {
      shape(input, ['id', 'manifest', 'signature']);
      return store.transaction(async tx => {
        const { credential, principal } = await owner(actor, tx);
        const manifest = verify(input, principal);
        const old = await tx.read('transfer-imports', input.id);
        if (old) {
          requireThat(old.value.ownerId === credential.principalId && digest(old.value.header) === digest(input), 'import_conflict');
          return { id: input.id, state: old.value.state, received: old.value.received };
        }
        await admitImport(tx);
        requireThat(!await tx.read('projects', manifest.projectId), 'project_id_taken');
        const count = await tx.read('import-capacity', credential.principalId);
        requireThat((count?.value.count ?? 0) < 10, 'capacity_reached');
        await tx.write('import-capacity', credential.principalId, { count: (count?.value.count ?? 0) + 1 }, count?.revision ?? 0);
        await tx.write('transfer-imports', input.id, { ownerId: credential.principalId, projectId: manifest.projectId,
          header: input, state: 'receiving', received: [], createdAt: now() }, 0);
        return { id: input.id, state: 'receiving', received: [] };
      });
    },
    async receive(actor, { archiveId, page, records }) {
      return store.transaction(async tx => {
        const row = await imported(actor, archiveId, tx), value = row.value;
        integer(page, 0, value.header.manifest.pages.length - 1);
        requireThat(Array.isArray(records) && records.length <= 100 && Buffer.byteLength(canonical(records)) <= 200000 &&
          digest(records) === value.header.manifest.pages[page], 'archive_page_corrupt');
        if (value.received.includes(page)) return { id: archiveId, state: value.state, received: value.received };
        requireThat(value.state === 'receiving', 'import_conflict');
        await artifacts.put(tx, value.projectId, records);
        const received = [...value.received, page].sort((a, b) => a - b);
        await tx.write('transfer-imports', archiveId, { ...value, received }, row.revision);
        return { id: archiveId, state: value.state, received };
      });
    },
    async commit(actor, archiveId) {
      return store.transaction(async tx => {
        const row = await imported(actor, archiveId, tx), value = row.value;
        if (value.state === 'complete') return (await tx.read('projects', value.projectId)).value;
        requireThat(value.received.length === value.header.manifest.pages.length, 'archive_pages_missing');
        const pages = [];
        for (const hash of value.header.manifest.pages) pages.push(await artifacts.get(value.projectId, hash, tx));
        const { principal } = await owner(actor, tx);
        const archive = verifyProjectArchive({ ...value.header, pages }, { trustedOperators, expectedOwner: principal });
        const records = archive.records, original = records.find(r => r.collection === 'projects').value;
        requireThat(digest(original.transfer) === digest(archive.manifest.transfer), 'transfer_fence_mismatch');
        integer(original.createdAt);
        const project = await identity.importProject(actor, original, { operator: archive.manifest.operatorId,
          archiveId, transferId: archive.manifest.transfer.id, importedAt: now(), historyAuthority: 'historical-only' }, tx);
        const files = new Map(records.filter(r => r.collection === 'artifacts').map(r => [r.value.hash, r]));
        const snapshots = records.filter(r => r.collection === 'snapshots');
        requireThat(snapshots.length <= (await limit('snapshotsPerProject', tx) ?? 64), 'capacity_reached');
        let bytes = 0;
        for (const record of files.values()) {
          const file = record.value;
          sourcePath(file.path); sourceText(file.content);
          requireThat(Buffer.byteLength(file.content) <= 48000 &&
            digest({ path: file.path, content: file.content }) === file.hash &&
            record.id === digest({ projectId: project.id, id: file.hash }), 'archive_source_corrupt');
          await tx.write('artifacts', record.id, file, 0);
        }
        for (const record of snapshots) {
          const snapshot = record.value;
          requireThat(digest(snapshot.files) === snapshot.id && record.id === digest({ projectId: project.id, id: snapshot.id }) &&
            snapshot.files.every(f => files.has(f.hash) && files.get(f.hash).value.path === f.path), 'archive_source_corrupt');
          bytes += Buffer.byteLength(canonical(snapshot.files.map(f => {
            const { path, content, hash } = files.get(f.hash).value; return { path, content, hash };
          })));
          await tx.write('snapshots', record.id, snapshot, 0);
        }
        requireThat(bytes <= (await limit('snapshotBytesPerProject', tx) ?? 8000000), 'capacity_reached');
        await consumeSnapshotBytes(tx, bytes);
        await tx.write('snapshot-capacity', project.id, { count: snapshots.length, bytes }, 0);
        // All remaining records stay in signed history pages. No imported job,
        // balance, signature, publication or onchain permission becomes active.
        await tx.write('imported-history', project.id, { projectId: project.id, archiveId, header: value.header, pages: value.header.manifest.pages }, 0);
        await tx.write('transfer-imports', archiveId, { ...value, state: 'complete', completedAt: now() }, row.revision);
        return project;
      });
    },
    async history(actor, projectId, { page }) {
      await identity.authorize(actor, 'artifact.read', { projectId });
      const saved = (await store.read('imported-history', projectId))?.value;
      requireThat(saved, 'not_found');
      if (page === undefined) return saved.header;
      integer(page, 0, saved.pages.length - 1);
      return artifacts.get(projectId, saved.pages[page]);
    }
  };
  return api;
}
