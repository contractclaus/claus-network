# Operation and recovery

Production state is stored in PostgreSQL; it does not fall back to a temporary local database. SQLite is supported for local development. Migration credentials are separate from runtime credentials.

State transitions are short database transactions. Provider calls and compilation happen outside those transactions. A worker lease fences stale workers from committing results. External effects retain a stable identity across retries and restarts.

## Failure handling

- Preserve an operation's original idempotency key and exact input when checking an uncertain outcome.
- Read the original job before submitting new work. A new key represents a new request, not recovery.
- Cancel queued work through the job endpoint. A marked external effect requires reconciliation instead of deleting its record.
- If a token is lost or its response was interrupted, recover with owner authentication and revoke the affected mandate or credential.
- A temporary graph failure does not withdraw a project. Publication state comes from the registry.

Initial rate limits are separate from any future financial allowance. Authentication accepts at most 30 requests per peer per five minutes and 200 globally. Other admitted API requests accept at most 300 per peer and 3,000 globally per five minutes. MCP transport and tool admission both count. Errors are explicit; clients should back off.

## Exports

`POST /v1/projects/{projectId}/exports` with `snapshotId` returns the project's identity, selected snapshot and source files. It requires `project.export` and current source-read access. This is a source export, not yet a complete export of future wallets, provider accounts or contract execution history.

## Operating your own instance

Use a separate database and operator credentials. Run schema setup with the migration role, then start the service with the runtime role. Configure the API origin and a private rate-limit salt. The hosted compiler trigger requires a separate private cron secret. Never publish database connection strings, provider tokens, payment authorizations or wallet keys.

The current build worker does not hold a wallet signing key. Automatic financial and contract execution requires a separately scoped signer and verified mandates; merely running the API does not grant that authority.
