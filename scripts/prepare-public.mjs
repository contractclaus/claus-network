import { mkdir, writeFile } from 'node:fs/promises';
await mkdir(new URL('../public/', import.meta.url), { recursive: true });
await writeFile(new URL('../public/index.html', import.meta.url), '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Claus | API</title><h1>Claus Network API</h1><p><a href="/openapi.json">OpenAPI</a> · <a href="/health">Service status</a></p><p>Project registration and public source snapshots. Review execution is not enabled in this release.</p></html>\n');
