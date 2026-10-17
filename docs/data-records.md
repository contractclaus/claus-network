# Persistent project data

Projects can store private JSON state through the same API, MCP, SDK and CLI. The data remains in the managed database when a container stops, restarts or is replaced.

Use `data_record_put`, `data_record_get`, `data_record_list` and `data_record_delete`. Reads require `artifact.read`; changes require `artifact.write`. Every operation is bound to its project. There is no raw SQL access or public listing of private values.

A record is addressed by `projectId`, `namespace` and `key`. Create with `expectedRevision: 0`. Read the returned revision before changing or deleting an existing record. Retain the original `idempotencyKey` if a request times out; repeating it returns the original write receipt and cannot overwrite a later version.

```js
await client.call('data_record_put', {
  projectId,
  namespace: 'app',
  key: 'settings',
  value: { theme: 'orange', visits: 0 },
  expectedRevision: 0,
  idempotencyKey: 'initial-settings'
});
```

`data_record_get` returns the current value and revision. `data_record_list` accepts a namespace and cursor; follow `nextCursor`, including when a page contains only deleted entries. Deletion keeps a tombstone and request receipt. Binary files and large exports continue to use the existing private `data_file_*` operations.

Limits: 32 KiB per record, 32 MiB and 10,000 active records per project, 50,000 recorded mutations per project. Capacity counts are returned with the list. This is managed project state, not a mounted filesystem.

A worker explicitly configured with `dataAccess: read` or `read_write` can read these records. `read_write` also allows writes. Existing worker limits remain 8 KiB writes, 4 KiB returned data and ten listed records; worker deletion is not enabled. Stop and revocation remove its access.
