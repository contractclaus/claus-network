import { canonical, copy, digest, integer, requireThat, text } from '../shared/index.mjs';

const filePath = value => {
  requireThat(typeof value === 'string' && value.length <= 180 &&
    /^[a-zA-Z0-9_/-]+\.(sol|json|md|txt|html|css|js|svg)$/.test(value) &&
    !value.startsWith('/') && !value.includes('//') && !value.split('/').includes('..'), 'invalid_file_path');
  return value;
};
const projectRef = (projectId, id) => digest({ projectId, id });
const prose = (value, maximum) => {
  requireThat(typeof value === 'string' && value.length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), 'invalid_text');
  return value;
};

export function createProjects({ store, identity, publicDetails = async () => ({}), now = () => Date.now() }) {
  async function snapshot(reader, projectId, id) {
    const value = (await reader.read('snapshots', projectRef(projectId, id)))?.value;
    requireThat(value && value.projectId === projectId, 'not_found');
    return value;
  }
  const api = {
    async get(actor, projectId) {
      const project = await identity.project(actor, projectId);
      const publication = await store.read('public-projects', project.slug);
      return { ...project, publication: { published: publication?.value.published === true,
        revision: publication?.revision ?? 0, description: publication?.value.description ?? '' } };
    },
    async createSnapshot(actor, projectId, { files, expectedProjectRevision }) {
      integer(expectedProjectRevision, 1);
      requireThat(Array.isArray(files) && files.length > 0 && files.length <= 64, 'invalid_files');
      const clean = files.map(file => {
        requireThat(file && Object.keys(file).length === 2 && typeof file.content === 'string', 'invalid_file');
        const path = filePath(file.path), content = prose(file.content, 48000);
        requireThat(Buffer.byteLength(content) <= 48000, 'file_too_large');
        return { path, content, hash: digest({ path, content }) };
      }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
      requireThat(new Set(clean.map(x => x.path)).size === clean.length, 'duplicate_file');
      requireThat(Buffer.byteLength(canonical(clean)) <= 256000, 'snapshot_too_large');
      const id = digest(clean.map(({ path, hash }) => ({ path, hash })));
      return store.transaction(async tx => {
        await identity.authorize(actor, 'snapshot.create', { projectId }, tx);
        const project = await tx.read('projects', projectId);
        requireThat(project.revision === expectedProjectRevision, 'revision_conflict');
        const old = (await tx.read('snapshots', projectRef(projectId, id)))?.value;
        if (old) return old;
        const usage = await tx.read('snapshot-capacity', projectId);
        const bytes = Buffer.byteLength(canonical(clean));
        requireThat((usage?.value.count ?? 0) < 64 && (usage?.value.bytes ?? 0) + bytes <= 8000000, 'capacity_reached');
        for (const file of clean) {
          const key = projectRef(projectId, file.hash);
          if (!await tx.read('artifacts', key)) await tx.write('artifacts', key, { projectId, ...file }, 0);
        }
        const value = { id, projectId, files: clean.map(({ path, hash }) => ({ path, hash })), createdAt: now() };
        await tx.write('snapshots', projectRef(projectId, id), value, 0);
        await tx.write('snapshot-capacity', projectId, { count: (usage?.value.count ?? 0) + 1,
          bytes: (usage?.value.bytes ?? 0) + bytes }, usage?.revision ?? 0);
        await tx.event({ type: 'snapshot.created', projectId, snapshotId: id, at: now() });
        return value;
      });
    },
    async snapshot(actor, projectId, id) {
      await identity.authorize(actor, 'artifact.read', { projectId });
      return snapshot(store, projectId, id);
    },
    async describeSnapshot(actor, projectId, id) {
      const version = await api.snapshot(actor, projectId, id);
      const publication = await store.read('public-sources', projectRef(projectId, id));
      return { ...version, publication: { published: publication?.value.published === true,
        revision: publication?.revision ?? 0 } };
    },
    async files(actor, projectId, snapshotId) {
      await identity.authorize(actor, 'artifact.read', { projectId });
      const version = await snapshot(store, projectId, snapshotId);
      const result = [];
      for (const entry of version.files) result.push((await store.read('artifacts', projectRef(projectId, entry.hash))).value);
      return result;
    },
    async publishSource(actor, projectId, { snapshotId, expectedRevision, published }) {
      requireThat(typeof published === 'boolean', 'invalid_publication'); integer(expectedRevision);
      return store.transaction(async tx => {
        await identity.authorize(actor, 'source.publish', { projectId, withdrawal: !published }, tx);
        const version = await snapshot(tx, projectId, snapshotId), key = projectRef(projectId, snapshotId);
        const old = await tx.read('public-sources', key);
        requireThat((old?.revision ?? 0) === expectedRevision, 'revision_conflict');
        const result = await tx.write('public-sources', key, { projectId, snapshotId, published, files: version.files }, expectedRevision);
        await tx.event({ type: published ? 'source.published' : 'source.withdrawn', projectId, snapshotId, at: now() });
        return { id: key, revision: result.revision, published };
      });
    },
    async publicSource(id) {
      const publication = (await store.read('public-sources', text(id)))?.value;
      requireThat(publication?.published === true, 'not_found');
      const files = [];
      for (const entry of publication.files) {
        const artifact = (await store.read('artifacts', projectRef(publication.projectId, entry.hash))).value;
        files.push({ path: artifact.path, content: artifact.content, hash: artifact.hash });
      }
      return { projectId: publication.projectId, snapshotId: publication.snapshotId, files };
    },
    async publish(actor, projectId, { published, expectedRevision, description = '' }) {
      requireThat(typeof published === 'boolean', 'invalid_publication'); integer(expectedRevision); prose(description, 500);
      return store.transaction(async tx => {
        await identity.authorize(actor, 'project.publish', { projectId, withdrawal: !published }, tx);
        const project = (await tx.read('projects', projectId)).value;
        const old = await tx.read('public-projects', project.slug);
        requireThat((old?.revision ?? 0) === expectedRevision, 'revision_conflict');
        const value = { projectId, slug: project.slug, name: project.name, description, published, updatedAt: now() };
        const result = await tx.write('public-projects', project.slug, value, expectedRevision);
        await tx.event({ type: published ? 'project.published' : 'project.withdrawn', projectId, at: now() });
        return { ...result.value, revision: result.revision };
      });
    },
    async publicProject(slug) {
      const record = await store.read('public-projects', text(slug));
      requireThat(record?.value.published === true, 'not_found');
      // Evidence is written only by the trusted workflow, not profile input.
      const evidence = (await store.read('public-evidence', record.value.projectId))?.value ?? { reviews: [], decisions: [], deployments: [] };
      return { ...record.value, revision: record.revision, evidence, ...await publicDetails(record.value.projectId) };
    },
    async graph({ after = '', limit = 100 } = {}) {
      const records = await store.list('public-projects', { after, limit });
      const projects = records.filter(x => x.value.published).map(x => ({
        id: x.value.projectId, slug: x.value.slug, label: x.value.name, kind: 'project',
        href: '/p/' + x.value.slug, revision: x.revision, status: 'registered'
      }));
      return {
        schemaVersion: '1.0', observedAt: now(),
        nodes: [{ id: 'claus', label: 'Claus', kind: 'coordinator', href: '/Home' }, ...projects],
        edges: projects.map(p => ({ source: p.id, target: 'claus', relation: 'registered_with' })),
        nextCursor: records.length === limit ? records.at(-1).id : null
      };
    },
    async export(actor, projectId, { snapshotId }) {
      await identity.authorize(actor, 'project.export', { projectId });
      const project = await identity.project(actor, projectId);
      const version = await snapshot(store, projectId, snapshotId);
      const files = await api.files(actor, projectId, snapshotId);
      return { schemaVersion: '1.0', exportedAt: now(), project, snapshot: version,
        files: files.map(({ path, content, hash }) => ({ path, content, hash })) };
    }
  };
  return api;
}
