export function createServiceConformance({ store, services }) {
  return {
    async tick() {
      const saved = await store.read('runtime-cursors', 'services');
      const rows = await store.list('service-versions', { after: saved?.value.after ?? '', limit: 30 });
      const states = [];
      for (const row of rows) if (row.value.state === 'proposed') {
        try {
          await services.probe(row.id);
          const checked = await services.checkProbe(row.id);
          states.push({ id: row.id, state: checked.state });
        } catch (error) {
          // Project-local invalidation must not starve unrelated providers.
          // Storage/transport faults still fail the tick; never certify it healthy.
          if (!['service_not_available', 'service_not_proposed', 'service_schema_mismatch',
            'project_unavailable', 'scope_denied'].includes(error.code)) throw error;
          states.push({ id: row.id, state: 'blocked', reason: error.code });
        }
      }
      const expired = await services.expire({ after: saved?.value.expiryAfter ?? '', limit: 100 });
      await store.transaction(async tx => {
        const cursor = await tx.read('runtime-cursors', 'services');
        if ((cursor?.revision ?? 0) !== (saved?.revision ?? 0)) return;
        await tx.write('runtime-cursors', 'services', { after: rows.length === 30 ? rows.at(-1).id : '',
          expiryAfter: expired.nextCursor ?? '' }, cursor?.revision ?? 0);
      });
      return { states };
    }
  };
}
