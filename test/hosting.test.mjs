import test from 'node:test';
import assert from 'node:assert/strict';
import { requestUrl } from '../runtime/request-url.mjs';
test('host routing preserves encoded resource IDs and real query fields', () => {
  const origin = 'https://claus-network-api.vercel.app';
  const path = '/v1/projects/p/sources/sha256%3A123/publication';
  const params = new URLSearchParams({ __claus_route: decodeURIComponent(path), path: decodeURIComponent(path.slice(4)) });
  assert.equal(requestUrl(path + '?' + params, origin).pathname, path);
  assert.equal(requestUrl(path + '?' + params, origin).search, '');
  assert.equal(requestUrl('/v1/public/graph?path=public%2Fgraph&limit=10', origin).search, '?limit=10');
  assert.equal(requestUrl('/v1/public/graph?path=unrelated', origin).search, '?path=unrelated');
  assert.equal(requestUrl('/v1/public/graph?__claus_route=/v1/projects', origin).pathname, '/v1/public/graph');
});
