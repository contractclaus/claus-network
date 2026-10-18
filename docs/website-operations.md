# Website operation

Claus can develop and publish his website through the existing operational source tools. Text changes, new files, binary asset replacement, exact file deletion and cron schedule changes use the retained source/review/deployment flow. Every deployment keeps the previous immutable source for code rollback. The publication baseline records every deployed file, while source listings page through editable files with an optional prefix and offset.

For binary files, `manage_website` with operation `stage_asset` and input `{ "url": "https://...", "sha256": "<optional expected SHA-256>" }` imports up to 25 MB into immutable hosting storage. Its returned asset ID can be used in a website source change with `action: "replace"`, `encoding: "base64"`, `assetId`, empty `before`/`after`, and the current `expectedSha` for an existing file. This stages bytes without publishing them. Small replacements may use canonical base64 directly. File deletion uses `action: "delete"`, the current `expectedSha`, and an empty `after`; binary deletions also use `encoding: "base64"` and an empty `before`.

The private manage_website tool reads actual hosting, environment, DNS and database state. Changes use a version-1 JSON plan with a reason in operations/website/<name>.json, published through the same source review. Applying an active plan retains its original action and provider result; recovery does not repeat an uncertain provider write.

The domain grant covers claus.si and its subdomains. Ordinary environment values use SITE_, NEXT_PUBLIC_, VITE_ or PUBLIC_ prefixes; account secrets remain in their custodians. Environment changes require a subsequent deployment. DNS records are administered through the connected Cloudflare zone.

New website data belongs in the claus_website schema, reached by server code through its existing database connection. Supported migrations create, rename and alter tables, columns and indexes. Destructive schema steps retain the affected table before the transactional change; a code rollback does not restore database contents. Existing financial records, signer access, unrelated accounts and the shared operating budget remain outside this website grant.

For example, a reviewed `operations/website/create-notes.json` plan can contain:

```json
{"version":1,"kind":"database","reason":"Store notes for a new website feature","steps":[{"operation":"create_table","table":"notes","columns":[{"name":"id","type":"uuid","primary":true},{"name":"body","type":"text","required":true}]}]}
```

After publishing the plan, read the current revision with `manage_website` operation `status`, then apply with input `{"path":"operations/website/create-notes.json","expectedRevision":123}` using the actual revision. Database steps also support `add_column` with a column object, `rename_table` with `table`/`name`, `rename_column` with `table`/`column`/`name`, `create_index` with `table`/`name`/`columns`/optional `unique`, `drop_index` with `name`, `drop_table` with `table`, `drop_column` with `table`/`column`, and `alter_type` with `table`/`column`/`type`. Types are `text`, `boolean`, `integer`, `bigint`, `numeric`, `uuid`, `jsonb`, `timestamptz`, `date`, `bytea` and `text[]`.

Domain plans use `kind: "domain"`, `operation: "set"`, `name`, and optional `redirect`/`redirectStatusCode`; removal and verification use operations `remove`/`verify`. Environment plans use `kind: "environment"`, operation `set`/`remove`, `key` and a `value` when setting. DNS plans use `kind: "dns"`, operation `set`/`remove`, `name`, `type`, `content`, `ttl`, optional `proxied`/`priority`, and the existing record `id` when updating or deleting. Every plan needs `version: 1` and a specific `reason`. Read existing state and retain the resulting action ID; `recover` reconciles that original action after an uncertain response.
