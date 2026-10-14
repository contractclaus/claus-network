import { copy, digest, integer, requireThat, shape, text } from '../shared/index.mjs';

export const PUBLIC_DATA_POLICY = Object.freeze({
  id: 'public-data-v1', publicInputs: true, outputReuse: 'public-including-onchain',
  providerSubdelegation: false, publication: 'explicit-buyer', maximumLineageDepth: 3
});
export const PUBLIC_DATA_POLICY_HASH = digest(PUBLIC_DATA_POLICY);

// Public output is a separate, revocable publication. A provider's manifest
// permits sharing; the buyer still chooses whether its actual result is public.
export function createPublicResults({ store, identity, artifacts, enabled, now }) {
  async function projectPublished(reader, id) {
    const p = (await reader.read('projects', id))?.value;
    return !!p && !p.archivedAt && !p.transfer && !(await reader.read('content-controls', id))?.value.held &&
      !(await reader.read('project-access', id))?.value.suspended &&
      (await reader.read('public-projects', p.slug))?.value.published === true;
  }
  async function read(id, reader = store, trail = new Set(), includeOutput = true) {
    text(id); requireThat(trail.size < 3 && !trail.has(id), 'result_lineage_invalid');
    const row = await reader.read('service-result-publications', id), p = row?.value;
    requireThat(p?.published && p.expiresAt > now(), 'public_result_unavailable');
    const order = (await reader.read('service-orders', id))?.value;
    const version = order && (await reader.read('service-versions', order.serviceId))?.value;
    requireThat(order?.purpose !== 'conformance' && order?.state === 'delivered' && order.acceptance === 'accepted' &&
      order.outputHash === p.outputHash && order.dataPolicyHash === PUBLIC_DATA_POLICY_HASH &&
      version?.manifest.dataPolicy === PUBLIC_DATA_POLICY.id && version.manifestHash === order.manifestHash &&
      version.state === 'available' && version.manifest.validUntil > now() &&
      (await reader.read('service-publications', order.serviceId))?.value.published === true &&
      await projectPublished(reader, order.projectId) && await projectPublished(reader, order.providerProjectId), 'public_result_unavailable');
    const path = new Set([...trail, id]);
    for (const source of p.sourceResults) {
      const actual = await read(source.id, reader, path, false);
      requireThat(actual.revision === source.revision && actual.outputHash === source.outputHash, 'public_result_unavailable');
    }
    const value = { id, projectId: order.projectId, providerProjectId: order.providerProjectId,
      serviceId: order.serviceId, manifestHash: order.manifestHash, outputHash: p.outputHash,
      dataPolicy: PUBLIC_DATA_POLICY.id, dataPolicyHash: PUBLIC_DATA_POLICY_HASH,
      sourceResults: copy(p.sourceResults), depth: p.depth, revision: row.revision,
      deliveredAt: order.deliveredAt, publishedAt: p.publishedAt, expiresAt: p.expiresAt };
    if (includeOutput) value.output = await artifacts.get(order.projectId, p.outputHash, reader);
    return value;
  }
  async function sources(reader, refs) {
    requireThat(Array.isArray(refs) && refs.length <= 3 && new Set(refs.map(r => r?.id)).size === refs.length, 'invalid_result_sources');
    let depth = 1;
    for (const ref of refs) {
      shape(ref, ['id', 'revision', 'outputHash']); text(ref.id); text(ref.outputHash); integer(ref.revision, 1);
      const actual = await read(ref.id, reader, new Set(), false);
      requireThat(actual.revision === ref.revision && actual.outputHash === ref.outputHash, 'result_source_changed');
      depth = Math.max(depth, actual.depth + 1);
    }
    requireThat(depth <= 3, 'result_lineage_too_deep');
    return { sourceResults: copy(refs), depth };
  }
  async function list(projectId, { after = '', limit = 20 } = {}) {
    text(projectId); integer(limit, 1, 100);
    requireThat(await projectPublished(store, projectId), 'not_found');
    const prefix = projectId + ':';
    requireThat(!after || after.startsWith(prefix), 'invalid_cursor');
    const rows = await store.list('project-public-results', { prefix, after, limit }), results = [];
    for (const row of rows) if (row.value.published) {
      try { results.push(await read(row.value.orderId, store, new Set(), false)); }
      catch (error) { if (error.code !== 'public_result_unavailable') throw error; }
    }
    return { results, nextCursor: rows.length === limit ? rows.at(-1).id : null };
  }
  return { read, sources, list,
    async publication(actor, projectId, orderId) {
      await identity.authorize(actor, 'service.read', { projectId });
      requireThat((await store.read('service-orders', text(orderId)))?.value.projectId === projectId, 'not_found');
      const row = await store.read('service-result-publications', orderId);
      return { id: orderId, published: false, ...row?.value, revision: row?.revision ?? 0 };
    },
    async publish(actor, projectId, { orderId, outputHash, published, expectedRevision, expiresAt }) {
      requireThat(typeof published === 'boolean', 'invalid_publication'); integer(expectedRevision); text(orderId); text(outputHash);
      return store.transaction(async tx => {
        await identity.authorize(actor, 'project.publish', { projectId, withdrawal: !published }, tx);
        const order = (await tx.read('service-orders', orderId))?.value;
        requireThat(order?.projectId === projectId && order.purpose !== 'conformance', 'not_found');
        requireThat(order.outputHash === outputHash, 'result_mismatch');
        const old = await tx.read('service-result-publications', orderId);
        requireThat((old?.revision ?? 0) === expectedRevision, 'revision_conflict');
        let value;
        if (published) {
          await enabled(projectId, tx);
          const version = (await tx.read('service-versions', order.serviceId))?.value;
          integer(expiresAt, now() + 1000, version?.manifest.validUntil ?? 0);
          requireThat(order.state === 'delivered' && order.acceptance === 'accepted' &&
            order.dataPolicyHash === PUBLIC_DATA_POLICY_HASH && version?.manifest.dataPolicy === PUBLIC_DATA_POLICY.id &&
            version.manifestHash === order.manifestHash && version.state === 'available' &&
            (await tx.read('service-publications', order.serviceId))?.value.published === true &&
            await projectPublished(tx, projectId) && await projectPublished(tx, order.providerProjectId), 'result_not_publishable');
          const lineage = await sources(tx, order.sourceResults ?? []);
          value = { projectId, orderId, outputHash, published, expiresAt, publishedAt: now(), ...lineage };
        } else {
          requireThat(old, 'not_found'); value = { ...old.value, published: false };
        }
        const row = await tx.write('service-result-publications', orderId, value, expectedRevision);
        const key = projectId + ':' + String(9999999999999 - order.deliveredAt).padStart(13, '0') + ':' + orderId;
        const index = await tx.read('project-public-results', key);
        await tx.write('project-public-results', key, { projectId, orderId, published }, index?.revision ?? 0);
        await tx.event({ type: published ? 'service.result_published' : 'service.result_withdrawn', projectId, orderId, at: now() });
        return { id: orderId, ...value, revision: row.revision };
      });
    },
    async forProject(projectId) {
      if (!await projectPublished(store, projectId)) return [];
      return (await list(projectId)).results;
    }
  };
}
