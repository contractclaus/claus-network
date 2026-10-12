# Operation and recovery

Production state is stored in PostgreSQL; it does not fall back to a temporary local database. SQLite is supported for local development. Migration credentials are separate from runtime credentials.

State transitions are short database transactions. Provider calls and compilation happen outside those transactions. A worker lease fences stale workers from committing results. External effects retain a stable identity across retries and restarts.

## Failure handling

- Preserve an operation's original idempotency key and exact input when checking an uncertain outcome.
- Read the original job before submitting new work. A new key represents a new request, not recovery.
- Cancel queued work through the job endpoint. A marked external effect requires reconciliation instead of deleting its record.
- If a token is lost or its response was interrupted, recover with owner authentication and revoke the affected mandate or credential.
- A temporary graph failure does not withdraw a project. Publication state comes from the registry.
- A changed block hash in finalized event recovery blocks the affected registration or execution with `recovery_block_changed`. Its cursor, signed transaction and accounting remain intact for operator investigation. This is an explicit stop, not a refund or permission to resend under a new identity.

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

`review_admission_*` manages a separate finite, expiring sponsorship policy. It requires both available deposited IMD and per-owner/project/global admission. Its lifetime exposure counts reserved or settled maximum cost; only provably unsent cancellations return their share. A new policy version never resets historical use. No policy call deposits money or increases a wallet allowance.

`chain_admission_*` manages a separate finite, expiring readonly profile. The default is Sepolia; the prepared Mainnet profile uses chainId 1 and a separate policy and ledger. It pins executor code, target build and independently reviewed evidence plus the operator’s explicit public-scope assessment. Global/project gas reservations and receipts survive expiry and policy changes. Expiry blocks new spending, while already submitted transactions remain reconcilable. All signing workers must run the compatible code before this policy is enabled. Mainnet, customer custody, inference and token launches remain separate gates.

Pilot `review_pilot_set` accepts optional `perProjectDay` and `globalDay` limits (defaults 2 and 8). Only the network owner may set them; quota changes never clear historical counts or create credit. Public sponsorship uses separate admission counters, so earlier internal pilots do not consume a newly authorized public allocation. Public daily, active-work and lifetime bounds remain independently enforced.


## Public admission failure boundaries

The intake scanner filters the indexed binding and requester topics from live registered bindings before paging. Exact requester/binding pairs are checked before the 32-event work limit. It narrows dense RPC ranges and retains a block/log cursor. A transient scan or observation failure retains the cursor while existing result delivery continues. Rejection diagnostics retain the latest rejection per admitted binding, rather than an unbounded row per hostile event. Public projects have one queued/waiting intake request at a time; existing pilot binding quotas are unchanged.

Public Claus decisions, including expired pilot projects before their first public gas reservation, are limited to two per project/day, eight globally/day, four per project over its lifetime and 32 globally over the initial allocation. These admission ceilings narrow the existing model budget; they do not create funding. Cancelled attempts still count toward these attempt limits. Public module deployment, registration submission, proposals and intake bindings require a delegated agent credential; the owner session prepares/signs registration and creates or revokes the delegation. A binding cannot outlive its credential.

Only provably unsent review payments release their sponsor reservation and public lifetime exposure. Daily admission counters still count these attempts. Local signing failures are closed through the same fenced cancellation path after restart. A persisted submission with an uncertain payment outcome remains reserved until payment evidence resolves it. An unpaid/expired provider response is not proof that an Ethereum permit was never used.

Public dispatcher allocations include a per-project ceiling in addition to the transaction and total ceilings. The proposed seven-day allocation is 0.0004 test ETH total and 0.00005 per project and per transaction. Both limits apply; unused project capacity is not a guaranteed reserved allocation. Gas/cost deferrals expose a reason and a 15-minute backoff; a busy wallet uses one minute. Pending transactions keep their original budget after a budget rotation. Revoking that budget can stop its unsent callback; read the canonical Inbox result or explicitly reconcile the original authority. A new budget never silently authorizes an old callback.

A broadcast with no final receipt retains its wallet slot and reservation, even after expiry. Operators must reconcile its original hash and nonce onchain; neither an RPC error nor a missing mempool entry proves that the signed transaction cannot execute. There is no automatic fee bump or replacement spending authority. Public admission may pause at these finite limits. EOA-based limits are per address, not proof of one human; global ceilings remain the hard spend bound.


## Admission recovery

A project can hold one active registration intent. Repeating the same preparation returns that intent, while a different input is refused until it expires or terminates. No more than 16 registration preparations are retained per project. Submission rejects an already-bound project and concurrent alternative registrations; existing original IDs remain readable.

Registration and execution already performed by a relayer are recognized from the exact onchain event, state and canonical receipt. A reverted local attempt retains its gas charge. It is never relabelled a successful transaction; the actual successful transaction is the reported result.

After a lost broadcast, the same encrypted signed bytes may be sent again at most once per minute while the original authority and expiry remain valid. This uses the same hash, nonce, fee and reservation. Revocation/expiry forbid further sends but preserve unresolved exposure. This does not add fee-bump, cancellation or replacement authority.

An unsent chain action becomes blocked once its original transaction window expires. Gas-price and available-budget deferrals may wait within that window; they cannot extend it. An expired unsent callback closes without spending. If someone else delivers a callback first, the worker checks the exact finalized Inbox result and records completion with its original resolution receipt.

A cancelled review whose billing is provably void may be requested again with a new idempotency key for the same source. Its old ID, receipt history and daily attempt count remain unchanged. Paid or uncertain reviews cannot be replaced this way.

The eight active review slots are shared by public and operator-pilot work to bound overall provider concurrency. Public and operator funding and daily quotas are separate, but neither has reserved concurrency. Per-project gas ceilings are upper bounds, not reserved shares or a guarantee that eight complete lifecycles fit the total allocation. A transaction mined after a requester cancels can still consume gas; actual reverted gas stays charged to the project's finite allocation.


Chain workers check their configured signing role against the current capability before claiming jobs, even when admission is disabled. Missing chain ports defer before marking an external effect. Existing effects retain their original reconciliation path. Registration and execution recovery use bounded, resumable finalized event ranges; no request scans all chain history in one RPC call. One cursor per original recovery identity is retained as operational history.
