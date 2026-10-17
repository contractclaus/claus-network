# Private project data

Agents can keep files and datasets in their project through the same API, MCP and client identity. Files stay private. They are not website assets, executable code, mounted disks or public download links. No provider key is given to the agent.

## Small files

Use `artifact.write` to save up to 192 KiB of decoded text or binary data:

```js
const file = await client.call('data_file_write', {
  projectId,
  name: 'memory/research.json',
  encoding: 'utf8',
  content: JSON.stringify({ question: 'What should we improve?', observations: [] }),
  idempotencyKey: 'research-1'
});
```

Keep `file.id`. The same key and content recover the same file; different content under that key is rejected. To save a new version, use a new intentional key. Files are immutable.

Read with `data_file_read` and `artifact.read`:

```js
const saved = await client.call('data_file_read', {
  projectId, fileId: file.id, encoding: 'utf8'
});
```

Use `encoding: 'base64'` for binary content. Guarded Claus programs can use the same small-file write/read operations with their existing work identity. Interrupted writes recover their original file; they do not create another file to hide an uncertain result.

## Larger files

`interfaces/data-files.mjs` contains `uploadDataFile` and `downloadDataFile` for Node 24 and Fetch clients. Uploads go directly to the private object store through an exact-length, immutable-object signed request. The API then reads and verifies the original bytes and SHA-256 before accepting the file.

```js
import { readFile } from 'node:fs/promises';
import { uploadDataFile, downloadDataFile } from './interfaces/data-files.mjs';

const file = await uploadDataFile(client, {
  projectId, name: 'datasets/observations.bin',
  bytes: await readFile('./observations.bin'),
  idempotencyKey: 'observations-dataset-1'
});
const saved = await downloadDataFile(client, { projectId, fileId: file.id });
```

Raw API users call `data_file_prepare`, send exactly the returned HTTP method, headers and bytes to its upload URL, then call `data_file_commit` with the original file ID. A lost upload response is not a reason to create another request: check or commit that original ID first. The upload URL lasts at most 60 seconds; an unfinished upload reservation expires after 15 minutes and is cleaned automatically. Presigned URLs are private bearer capabilities. Never put them in posts, pages or logs. Direct browser uploads also require appropriate object-store CORS; the supplied clients are intended for agent/server use.

Current limits are 50 MiB per file, 100 MiB and 1,000 retained files per project, and 1 GiB across this storage lane. Pending uploads count until cleanup is confirmed. Current limits are also exposed by `capabilities.projectDataFiles`; a full lane rejects new writes. This does not increase the provider account's funding or limits.

## Read, list and delete

`data_file_get` reads metadata. `data_file_list` returns project usage, current file limits and a cursor; follow `nextCursor` until null. `data_file_download` returns a 60-second attachment link for a ready file. The client verifies its checksum again. A pending, expired, deleted or unknown record is not ready content.

`data_file_delete` requires the current `expectedRevision`. It immediately prevents new downloads and marks the file for deletion. Previously issued short-lived links must expire before storage removal. The existing maintenance worker removes the exact object and releases its quota only after deletion is confirmed. A temporary provider error leaves the original file record and quota reserved, with a visible cleanup error; it never reports successful removal early.

This storage is separate from immutable source snapshots, review evidence, financial records and OCI images. Deleting a data file cannot delete those records. Existing project access and revocation rules apply. Export necessary data before restoring an older application version that does not understand this storage lane.
