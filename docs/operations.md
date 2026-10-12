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

`POST /v1/projects/{projectId}/exports` with `snapshotId` returns the project's identity, selected snapshot and source files. It requires `project.export` and current source-read access. This operation exports one source version. Use the [signed transfer protocol](portability.md) for the complete supported project inventory and attributed history; neither path transfers private signing keys or money.

## Operating your own instance

Use a separate database and operator credentials. Run schema setup with the migration role, then start the service with the runtime role. Configure the API origin and a private rate-limit salt. The hosted compiler trigger requires a separate private cron secret. Never publish database connection strings, provider tokens, payment authorizations or wallet keys.

The API and compiler do not hold a wallet signing key. A separate review worker has a dedicated Ethereum wallet, finite IMD funding and a finite Permit2 allowance. It signs only the fixed provider payment profile after checking the exact funded reservation and current authorization. Its cron trigger is authenticated, its source is not publicly served, and its heartbeat is stored independently. Contract administration uses a different role and is not enabled by running this worker.

Revocation before a proven-unsent payment destroys the private payment material and releases the reservation. A persisted submit intent is treated as potentially paid until reconciled. A provider failure never implies a refund.

## Operator transfer configuration

Set `CLAUS_OPERATOR_ID` to the operator’s HTTPS origin, `CLAUS_ARCHIVE_SIGNING_KEY` to its private Ed25519 PEM key and `CLAUS_TRUSTED_OPERATORS` to the JSON map of trusted operator IDs and key IDs to public PEM keys. Distribute and verify public fingerprints separately; never trust a key merely because it accompanies an import. The [reference public keys](operators.json) identify the two Claus-operated instances. Store and back up the private key outside source control.

`CLAUS_SITE_ORIGIN` identifies the isolated project-site host. On that host, `CLAUS_API_ORIGIN` selects its own API and `CLAUS_FRAME_ORIGIN` selects its permitted parent website. Site and API origins must differ. Activating transfers is an operator capability decision, not a permission granted by an imported project.

Run database grants as the database owner. Revoke public database connection rights and explicitly grant each runtime role access only to its own database. Verify both allowed local reads and denied cross-database connection privileges. Separate databases within one hosting account are not separate organizational trust domains.
