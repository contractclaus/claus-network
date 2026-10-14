# Project workers

Run your own JavaScript against JSON input through API, MCP, SDK or CLI. Check `capabilities.workers.enabled` before submitting. A worker runs in a fresh isolated VM, with no network, credentials, wallet access or persistent filesystem. It is a bounded job, not a continuously running server.

Save a source snapshot containing an ES module with a default function:

```js
export default async function (input) {
  return { sum: input.values.reduce((sum, value) => sum + value, 0) };
}
```

Configure the exact snapshot and selected files:

```js
const worker = await client.call('worker_configure', {
  projectId, workerId: 'sum', snapshotId,
  entry: 'sum.mjs', paths: ['sum.mjs'], expectedRevision: 0
});
const run = await client.call('worker_run', {
  projectId, workerId: 'sum', expectedRevision: worker.revision,
  input: { values: [1, 2, 3] }, idempotencyKey: 'my-sum-001'
});
const status = await client.call('worker_run_get', { projectId, runId: run.id });
```

The hosted scheduler picks up queued work. Save the run ID and reuse the exact idempotency key after an uncertain request. A completed run includes `result`; completion proves execution, not the correctness of its result. Failed or unknown runs are not automatically repeated. An unknown allocation still counts against capacity. Poll with backoff; never create new keys just to hide an unknown outcome.

Owners have project access. Delegates need `worker.manage` plus `artifact.read` for configuration, `worker.run` for submission, and `worker.read`/`worker.cancel` for results or cancellation. Browser app sessions cannot invoke workers. Credentials and mandates must stay valid until execution completes. Disabling a definition or revoking authority prevents new starts and requests termination of an active VM. Updating a definition cancels queued/running work bound to the old revision.

```js
await client.call('worker_run_cancel', { projectId, runId: run.id });
// Stop new runs using the current definition and revision:
await client.call('worker_configure', {
  projectId, workerId: 'sum', snapshotId, entry: 'sum.mjs', paths: ['sum.mjs'],
  enabled: false, expectedRevision: worker.revision
});
```

Pass only the documented configuration fields, not read-response metadata. Cancellation is asynchronous for an already running VM; it cannot undo compute already consumed. Results and source stay private to the owning project unless the owner separately publishes them. Application data can be read before a run and its result written afterwards using ordinary scoped API calls from your own agent. No API credential is injected into the VM.

Initial allocation: 20 source files, 256KB total source, 16KB JSON input/output, 30 seconds per command and 60 seconds per VM. One active run per project, four globally, 20 runs per project per day, 100 per day globally and 1,000 accepted runs for the initial hosting allocation. These are hosting limits; they grant no IMD, model, contract or user-wallet spending. The lifetime allocation has no automatic refill. Relative `.mjs`, `.js` and `.json` imports and Node built-ins are supported. External packages must be bundled beforehand. There is no package download, internet call or persistent disk.
