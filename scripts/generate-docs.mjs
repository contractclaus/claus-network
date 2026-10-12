import { readFile, writeFile } from 'node:fs/promises';
import { API_VERSION, ROUTES, openapi } from '../interfaces/contract.mjs';

const docs = new URL('../docs/', import.meta.url);
const origin = 'https://claus-network-api.vercel.app';
const access = {
  review_pilot_get: 'Network owner session', review_pilot_set: 'Network owner session',
  inference_profile_set: 'Network owner session', inference_allowance_set: 'Network owner session',
  project_transfer_prepare: 'Owner session; admitted project',
  project_transfer_page: 'Export capability', project_import_begin: 'Matching owner session',
  project_import_page: 'Matching owner session', project_import_commit: 'Matching owner session',
  project_import_history: 'Artifact read capability'
};
const header = '| Operation | Method | Path | Access |\n| --- | --- | --- | --- |';
const table = [header, ...ROUTES.map(route =>
  `| \`${route.name}\` | ${route.method} | \`${route.path}\` | ${access[route.name] ?? (route.public ? 'Public' : 'Bearer credential')} |`)].join('\n');
const file = new URL('api-reference.md', docs);
let text = await readFile(file, 'utf8');
const current = /\| Operation \| Method \| Path \| Access \|\n\| --- \| --- \| --- \| --- \|(?:\n\|[^\n]+\|)+/;
if (!current.test(text)) throw new Error('API reference table not found');
text = text.replace(current, () => table).replace(/The live API is [\d.]+ with \d+ operations\./,
  `The live API is ${API_VERSION} with ${ROUTES.length} operations.`);
await writeFile(file, text);
await writeFile(new URL('openapi.json', docs), JSON.stringify(openapi({ origin }), null, 2) + '\n');
console.log(JSON.stringify({ version: API_VERSION, operations: ROUTES.length }));
