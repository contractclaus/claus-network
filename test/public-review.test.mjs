import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../runtime/server.mjs';
import { openStore } from '../src/storage/index.mjs';
import { digest } from '../src/shared/index.mjs';

async function fixture(t) {
  const store = openStore(':memory:'); t.after(() => store.close());
  const app = createApplication({ store, rateSalt: 'test-only'.repeat(8) });
  const projectId = 'prj_test', caseId = digest('review'), sourceId = digest({ projectId, id: 'source' });
  const report = '# Stored report\n\n<script>untrusted()</script>\nNo external fetch required.';
  let artifactHash;
  await store.transaction(async tx => {
    artifactHash = await app.artifacts.put(tx, projectId, { complete: true, jobId: 'original-job', report,
      job: { privatePayment: 'must-not-be-public' }, submissions: [{ privateField: 'must-not-be-public' }],
      reportSource: { kind: 'accepted-audit-submission', privateField: 'must-not-be-public' } });
    await tx.write('projects', projectId, { id: projectId, slug: 'report-fixture' }, 0);
    await tx.write('public-projects', 'report-fixture', { projectId, published: true }, 0);
    await tx.write('public-sources', sourceId, { published: true }, 0);
    await tx.write('review-publications', caseId, { published: true }, 0);
    await tx.write('review-cases', caseId, { id: caseId, projectId, artifactHash,
      providerJobId: 'original-job', state: 'reviewed', input: { sourceHash: 'source' } }, 0);
    await tx.write('public-evidence', projectId, { reviews: [{ id: caseId, artifactHash }] }, 0);
  });
  const read = () => app.fetch(new Request('https://claus.si/v1/public/reviews/' + encodeURIComponent(caseId)));
  const change = (collection, id, fields) => store.transaction(async tx => {
    const row = await tx.read(collection, id); await tx.write(collection, id, { ...row.value, ...fields }, row.revision);
  });
  return { store, app, projectId, caseId, sourceId, report, artifactHash, read, change };
}

test('published reports remain readable without the provider and expose only the public report projection', async t => {
  const f = await fixture(t), response = await f.read();
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /application\/json/);
  const result = await response.json();
  assert.deepEqual(result, { caseId: f.caseId, projectId: f.projectId, artifactHash: f.artifactHash,
    provider: 'imd-audit-v1', providerJobId: 'original-job', report: f.report,
    reportHash: digest(f.report), sourceKind: 'accepted-audit-submission' });
  assert(!JSON.stringify(result).includes('must-not-be-public'));
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('withdrawn reviews, profiles and sources stop public report access', async t => {
  for (const kind of ['review', 'profile', 'source', 'archived', 'different-artifact']) {
    const f = await fixture(t);
    if (kind === 'review') await f.change('review-publications', f.caseId, { published: false });
    if (kind === 'profile') await f.change('public-projects', 'report-fixture', { published: false });
    if (kind === 'source') await f.change('public-sources', f.sourceId, { published: false });
    if (kind === 'archived') await f.change('projects', f.projectId, { archivedAt: Date.now() });
    if (kind === 'different-artifact') await f.change('public-evidence', f.projectId, { reviews: [] });
    assert.equal((await f.read()).status, 404, kind);
  }
});
