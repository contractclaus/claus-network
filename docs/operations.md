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

## Replacing an upgrade executor

A deployed executor and each project's target keep their original onchain rules. Publishing new source does not change an existing project's binding or shorten a queued approval. A replacement must have its own exact build, independent review, source verification and explicit operator admission.

The chain capability selects the default executor for new registrations. To adopt a replacement, retain the previous complete capability in `retainedExecutors`, including its address, runtime hash, approval signer, payer and target-artifact references. Workers select the exact entry belonging to each signed registration or existing project. Never overwrite a project's binding or relabel the old target as migrated.

Set a retained entry's `enabled` to false to deny new decisions and broadcasts for that executor; preserve the entry for reconciliation of transactions already sent. Removing the entry or its original journals prevents that reconciliation. A global chain disable still stops the chain worker. All accepted project delays and future approval start times remain enforced onchain. The replacement source permits an explicitly signed zero delay.

## Recovery checkpoints

The hosted reference stores an encrypted recovery bundle outside the serving hosts. It contains the released network source, protected operational checkpoints, the network's dedicated signer keystores and passphrases, and snapshots of both operator databases. The decryption key remains in the owner's existing protected recovery configuration; it is not included in the bundle. An encrypted bundle is still sensitive and belongs in private storage.

The bounded owner-funded reference transactions also have a journal in the shared owner signing service. The recovery bundle captures those exact network action IDs, signed transactions, local preparation files, and the observed chain locks and nonce high-water marks. It verifies each captured signature against the owner address without exporting the owner's key. These records are separate from the two network databases. Restoring them must first reconcile the live shared wallet and any unrelated transactions; never replace a live lock or move its nonce history backward.

Each database snapshot is read in a single repeatable-read transaction and includes every document with its revision, every event with its original sequence, and the event sequence generator state. These records include authorization revocations, outstanding jobs, reservations and external-effect identities. The two database snapshots are separate checkpoints, not an atomic transaction spanning both operators. Transfer receipts must be reconciled across that boundary after recovery.

On 12 October 2026, both snapshots were restored into disposable schemas. Their documents, revisions, events and sequence state matched exactly. The source operator still rejected the replaced agent's credential and accepted the successor's authorized read. No restored worker dispatched an external effect. The remote ciphertext was downloaded, checked, decrypted with the existing recovery key and compared with the original bundle. See the [recovery receipt](reference-recovery.json). This proves the recorded recovery exercise, not continuous backup coverage or a zero-data-loss guarantee.

## Restore procedure

1. Fence new mutations and stop workers and signing services. Record the newest available checkpoint and any activity since it was taken. Do not run restored workers while the original operator can still dispatch the same work.
2. Retrieve the private bundle and verify its recorded ciphertext hash. Decrypt it in the protected operator environment with the separately held recovery key. Keep plaintext files and database credentials out of logs and public artifacts.
3. Restore each database into a fresh, isolated database or schema using the matching released schema. Preserve document IDs and revisions, event sequences and generator state exactly. Restore operational checkpoints and signer journals without resetting consumed allowances, nonces or pending reservations.
4. Compare the restored rows and sequence state with the snapshot. Check a known revoked credential and an authorized read. Verify the destination operator's database grants and signing identity independently.
5. Reconcile every uncertain provider request, payment, chain transaction and transfer using its original ID and existing receipt. Read chain state and pending nonces before enabling signing. A missing result in the older checkpoint is not permission to pay or execute again. Include revocations and completed actions that occurred after the checkpoint.
6. Confirm current deployment source, capabilities, funding and signer restrictions. Resume read access first, then one class of worker at a time, preserving existing idempotency keys. Verify pending work and health before reopening admission. Take and verify a new encrypted checkpoint after recovery.

Recovery does not transfer an owner's authority to another operator. Lost or compromised credentials require the supported revocation and rotation process; restoring an older database must not revive them.

## Public-access release

The versioned `project-access` policy controls free collaboration and technical capacity. Use `access_policy_get`, `access_policy_publish` and `access_policy_activate` with the network owner session. Publication validates the complete configuration; activation compares the expected generation. `project_access_set` can suspend one abusive project. Neither API changes sponsor funds, chain grants, keys or existing accepted terms.

Counters survive policy changes and process restarts. Global new-project and new-snapshot-byte counters begin with this release; old project histories retain their previous per-project counts. Initial defaults: 64 new projects/day and 2,000 total, 64 MB new snapshot input/day and 512 MB total. This bounds new admission, not all accumulated database storage. Inspect actual database size separately. Global pause blocks new mutating work while preserving authorized reads, exports, withdrawals and reconciliation.

Before deploying the new compiler, run `node scripts/migrate-maintenance.mjs /absolute/private/operator-config.json` with the migration role. The config contains `migrationUrl`, `runtimeRole` and optional `schema`. The migration adds the project-page index and a fixed security-definer cleanup function. Runtime still has no table DELETE permission. The compiler invokes cleanup once per scheduled tick: at most 2,000 auth challenges or rate-limit rows expired more than 24 hours ago. No identity, revocation, job, financial, source or transaction history is pruned.

Publish compatible workers before enabling a new admission policy. Verify each uploaded source manifest and observed worker release; preserve active jobs, original payment IDs and leases. Public review and public chain policies stay disabled during this rollout.

`review_admission_*` manages a separate finite, expiring sponsorship policy. It requires both available deposited IMD and per-owner/project/global admission. Its lifetime exposure conservatively counts maximum admitted cost and is not reset by cancellation or a new policy version. No policy call deposits money or increases a wallet allowance.

`chain_admission_*` manages a separate finite, expiring Sepolia-only readonly profile. It pins executor code, target build and independently reviewed evidence plus the operator’s explicit public-scope assessment. Global/project gas reservations and receipts survive expiry and policy changes. Expiry blocks new spending, while already submitted transactions remain reconcilable. All signing workers must run the compatible code before this policy is enabled. Mainnet, customer custody, inference and token launches remain separate gates.
