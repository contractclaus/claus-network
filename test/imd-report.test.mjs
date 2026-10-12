import test from 'node:test';
import assert from 'node:assert/strict';
import { createImdReviewProvider } from '../adapters/imd.mjs';
import { digest } from '../src/shared/index.mjs';

function fixture(status = 503) {
  const job = { id: 'audit-1', state: 'completed', template: 'audit', nodes: [{ key: 'audit_judge', state: 'accepted' }] };
  const judge = { nodeKey: 'audit_judge', role: 'review', outcome: 'completed', accepted: true, safetyRefusal: false,
    verificationErrors: 0, baseCommit: 'a'.repeat(40), hash: 'b'.repeat(64), summary: 'One critical finding.',
    findings: [{ severity: 'critical', title: 'Preserve this finding', description: 'Do not activate.', proof: 'full proof', extra: { retained: true } }] };
  const submissions = { jobId: job.id, baseCommit: judge.baseCommit, repoUrl: 'https://github.com/example/project', submissions: [judge] };
  const calls = [];
  let cancelled = false;
  const provider = createImdReviewProvider({ fetch: async (url, options) => {
    calls.push([url, options.method]);
    if (url.endsWith('/report.md')) return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(status === 200 ? '# Canonical report' : 'busy')); },
      pull(controller) { if (status === 200) controller.close(); }, cancel() { cancelled = true; }
    }), { status, headers: { 'content-type': 'text/markdown' } });
    return Response.json(url.endsWith('/submissions') ? submissions : job);
  } });
  return { provider, job, judge, submissions, calls, cancelled: () => cancelled };
}

test('busy Markdown reports use the accepted provider submission and retain every finding', async () => {
  const f = fixture(); const result = await f.provider.report('audit-1');
  assert.equal(result.complete, true); assert.equal(result.reportSource.markdownStatus, 503);
  assert.equal(result.reportSource.submissionHash, f.judge.hash);
  assert(result.report.includes('critical') && result.report.includes('full proof') && result.report.includes('"retained": true'));
  assert.equal(result.reportHash, digest(result.report)); assert.deepEqual(result.submissions, f.submissions);
  assert(f.cancelled()); assert(f.calls.every(([, method]) => method === 'GET'));
});

test('an available canonical Markdown report is retained byte for byte', async () => {
  const result = await fixture(200).provider.report('audit-1');
  assert.equal(result.report, '# Canonical report'); assert.equal(result.reportSource, undefined);
});

test('incomplete, mismatched or unaccepted submissions cannot stand in for a report', async () => {
  for (const change of [f => { f.judge.accepted = false; }, f => { f.judge.baseCommit = 'c'.repeat(40); },
    f => { f.job.nodes[0].state = 'working'; }, f => { delete f.judge.findings; }, f => { f.submissions.jobId = 'wrong'; },
    f => { f.judge.verificationErrors = 1; }, f => { f.submissions.submissions.push({ ...f.judge }); }]) {
    const f = fixture(); change(f);
    await assert.rejects(f.provider.report('audit-1'), error => ['provider_audit_not_accepted', 'provider_invalid_audit_submission'].includes(error.code));
  }
});

test('authentication and missing-report failures are not replaced', async () => {
  for (const status of [401, 403, 404]) await assert.rejects(fixture(status).provider.report('audit-1'), { code: 'provider_request_rejected', httpStatus: status });
});

test('running audits remain incomplete and do not request submissions', async () => {
  const f = fixture(); f.job.state = 'executing';
  assert.deepEqual(await f.provider.report('audit-1'), { complete: false, state: 'executing' });
  assert.equal(f.calls.length, 1);
});
