# Bounded signal feeds

`claus-signal-v1` adds an immutable data store beside a reviewed `claus-readonly-v1` evaluator. Check `capabilities.signalProfiles` before preparing work: an API route or this guide is not admission. Ethereum and Sepolia have separate projects, factories, grants and budgets.

A publisher can write data under a finite owner-signed grant. It cannot change the evaluator, schema, project owner or upgrade authority. Evaluator changes use the existing independent review, genuine Claus decision and execution workflow. Grant revocation is separate from that workflow.

## From a project to a record

The [copyable Pulse walkthrough](pulse-walkthrough.md) covers the full lifecycle. Use the [quickstart](quickstart.md) to authenticate an EOA owner, create a project and delegate an agent. Complete the [review and contract workflow](reviews-and-contracts.md) for the Pulse evaluator before the steps below. The exact source is `contracts/src/ClausPulseModule.sol`, importing `ClausSignalTypes.sol`; compile with Solidity 0.8.27, optimizer 200, viaIR and Cancun. Its configuration is ABI-encoded `(uint256 thresholdWei, uint256 maximumAgeSeconds)`. This example supports one fixed public chain-observation schema; arbitrary funds or token hooks are outside the profile.

The agent needs `project.read`, `signal.read`, `signal.manage`, `signal.publish`, `signal.grant.revoke`, `service.call`, `service.read`, `service.settle` and, only when publishing, `project.publish`. `service.settle` allows the consumer to accept its delivered result. Keep owner and publisher signing keys in your own wallet tools. The API never returns a private wallet key.

All names below are available unchanged in SDK, CLI and MCP. Use `node interfaces/cli.mjs describe NAME` for the exact JSON schema. Store prepared responses, input bodies, resource IDs and transaction hashes before continuing.

1. Call `signal_store_prepare` with `{projectId,idempotencyKey}`. Review and sign the returned exact zero-value transaction as the project owner. Submit it through your own Ethereum connection. Call `signal_submit` with the returned operation ID and the original transaction hash. Poll `signal_operation` until `confirmed`, then read `signal_store`.
2. Call `signal_grant_prepare` with `{projectId,publisher,maximumWrites,minimumInterval,expiresAt,nonce,idempotencyKey}`. `expiresAt` is **Unix seconds**, `nonce` a decimal string, `minimumInterval` seconds. For example, 24 writes, 3,600 seconds apart, expiring in 24 hours. The owner checks and signs the returned `typedData` using EIP-712. Chain, store, project, feed, schema, publisher, authority generation and limits are signed together.
3. Call `signal_grant_register` with `{projectId,operationId,signature}`. The named publisher signs and sends the prepared transaction. Attach its hash with `signal_submit`; wait for finality through `signal_operation`. Save the grant ID. Repeating a grant cannot reset its usage or undo a revocation.
4. Obtain an accepted `public-data-v1` service result following [public data services](public-data.md). Explicitly publish it. The result's `onchainData` must contain the exact ABI-encoded observation `(uint256 chainId,uint64 blockNumber,bytes32 blockHash,uint64 observedAt,uint256 baseFeeWei)`.
5. Read `signal_latest` and the evaluator's current version. Call `signal_record_prepare` with `{projectId,grantId,sequence,expectedVersion,observedAt,validUntil,sourceResult,data,idempotencyKey}`. `sourceResult` is `{id,revision,outputHash}` from the public result; `data` must exactly equal its `onchainData`. Sequence increases globally across the store, including other grants. All observation times here are **Unix seconds**.
6. The granted publisher checks, signs and sends that transaction, then calls `signal_submit` and polls the same operation. Read the finalized result with `signal_latest`. `pending` never means it is safe to send a replacement write.
7. Publish your project profile separately, then call `signal_publish` with `{projectId,published:true,expectedRevision:0}` for its first publication. Thereafter use the revision returned by the operation. Your feed is now discoverable through `public_signal`, the network graph and your `/p/<slug>` page.

The source includes a working three-project orchestration example in `reference/pulse-pipeline.mjs`, fixed-data providers in `reference/pulse-providers.mjs` and a bounded publisher in `adapters/signal-publisher.mjs`. External agents may implement the same sequence in any language. No website onboarding is required.

## Limits and trust

| Item | Bound |
| --- | --- |
| Input / result | 2 KiB / 512 bytes |
| Evaluator call | STATICCALL, 200,000 gas |
| Grant | At most 10,000 writes and 30 days; explicit finite owner signature |
| Grant interval | 1 second to 7 days; concrete grants are normally tighter |
| Record validity | Within grant expiry and 24 hours of observation |
| Owner / publisher | EOA only; contract wallets and EIP-7702 are not admitted |
| Assets | No deposits, withdrawals, token management or arbitrary calls |

The owner may explicitly sign multiple grants; the per-grant maximum is not a global lifetime cap. An owner or authority change invalidates old grants. The publisher signs its own transactions and pays its own gas unless a separate operator allocation explicitly covers it. Free network access does not create unlimited gas or inference credit.

A finalized record proves what this store accepted. It does not prove an external observation true. Network Pulse compares two independent RPC sources, but its publisher still attests the input. Unknown financial consumers are not approved by publishing this feed.

## Revoke and recover

`signal_grant_revoke` records API revocation immediately and prepares the owner's onchain call. Sign and submit that call and observe finality. `signal_grant` reports the two states separately. API revocation cannot cancel an already-broadcast transaction or prevent a signer using its still-valid onchain grant directly. Only finalized onchain revocation removes that grant onchain. The owner can revoke a signed grant ID even before it is registered; registering it later cannot undo the revocation. Cancelling a nonce after registration reverts; revoke the grant ID instead.

Preserve the original operation and transaction hash after transport errors. `signal_operation`, `signal_latest`, `signal_grant` and resource listing remain readable when admission expires; revocation stays reachable. A new credential or grant never silently restores revoked rights. Withdrawn public results stop fresh reuse; already-published onchain data cannot be erased.

| Error | Action |
| --- | --- |
| `signal_stale_version` / `signal_stale_sequence` | Re-read current state; prepare new work only after settling any previous transaction |
| `signal_data_expired` | Obtain a fresh observation |
| `signal_interval_pending` | Respect the signed interval |
| `signal_grant_inactive` / `signal_grant_exhausted` | Stop; only the owner can expressly authorize a new grant |
| `signal_api_revoked` | Stop API publication; do not switch credentials to bypass it |
| `public_result_unavailable` / `signal_source_changed` | Stop reuse; inspect the source's publication |
| `signal_transaction_conflict` | Keep and reconcile the original hash |
| `signal_not_enabled` | Read capabilities and expiry; reads and revocation remain available |

## Record status

The latest record is immutable history. The API reads the evaluator and grant at the same finalized block: `withdrawn` means its grant or project authority is revoked, suspended or changed; `superseded` means the evaluator has since changed version; `stale` means the observation expired. Only an authorized record matching the current evaluator version and validity window is `current`. A withdrawn or superseded record is retained for inspection, never represented as a new observation.

Pulse runs hourly with a two-hour observation window. The run deadline limits new work; it does not shorten the observation's validity. Service publication, grant and observation expiry still bound publication. Interrupted broadcasts always reconcile their original transaction before new work.

## Existing stores and recovery

If a wallet replaces a creation transaction or the owner creates the store directly, call `signal_store_prepare` with a new recovery idempotency key. The API can adopt only the canonical, finalized factory store with exactly the admitted evaluator, feed and schema. A recovery returns `confirmed`, `recovered: true` and its finalized block evidence, without inventing a creation transaction hash. Any earlier uncertain transaction keeps its original hash and remains independently reconcilable. A canonical store missing from API evidence blocks evaluator approval until recovery supplies its consumer context.

A project can select one consumer profile, signal or vault. Selection occurs when store preparation first succeeds, before signing, and persists if an unsigned intent expires. There is no profile-switch operation; use a separate project for a different profile. Revocations have separate daily limits from normal writes (128 unique grant IDs and 128 prepared revocation calls); direct owner revocation remains available onchain.

An operator's unknown broadcast retains its budget and signer slot after expiry. They are released only by a canonical receipt, or by proof of a different finalized transaction from the same sender using the exact nonce. A higher account nonce or a missing receipt alone is insufficient. This recovery reads history and never creates a cancellation or replacement transaction.

## Time and authority boundaries

Use a grant shorter than the absolute 30-day contract ceiling, allowing for the difference between host time and block timestamps. A prepared call or successful simulation does not reserve block inclusion; leave substantial time before the observation and grant expire. The reference requires at least 15 minutes of remaining validity before preparing a record and uses a two-hour observation window. Its schedule, service publications and publisher budget must end no later than the signed grant. Do not configure a scheduler beyond its grant and expect automatic renewal.

Both sequence and `observedAt` are monotonic across all grants on one Store. Another authorized publisher may make an older observation unusable. Any authority-generation change, including proposing or cancelling an owner transfer or calling `setAuthority` again, invalidates old grants; explicit new grants are required. A successful repeat of `registerGrant` does not reset usage or prove that the grant is active. Read finalized grant state.

Grant preparation and registration use the latest chain timestamp: expiresAt must be at least head.timestamp + 61 and at most head.timestamp + 30 days. An out-of-range grant returns the non-retryable input error signal_grant_expiry (HTTP 400). Record preparation likewise requires more than 60 seconds before expiry. This margin is not an inclusion guarantee. The reference additionally clamps publication and record validity to the finalized grant expiry and ends unusably old runs without repeated publication attempts. API-revoked grants cannot receive a new registration intent.

During a chain dependency outage, discovery marks the affected signal profile `unavailable`; unrelated capabilities remain readable and writes fail closed. For hosted publishers, exact finalized replacement evidence from the transaction engine yields `signal_transaction_replaced` while retaining the original hash. External wallets remain responsible for reconciling their original unknown broadcasts.

An unregistered grant has no finalized grant record yet; this is the normal first-registration path. The owner signature is still verified. API revocation prevents new registration preparation immediately; direct onchain revocation is observed after finality. A registration racing a direct revocation can spend gas, but cannot reactivate the grant. Confirmed hosted writes keep their original API handoff pending across API outages until the hash and terminal outcome are recorded. Known admission configuration faults have distinct coded reasons; unknown transport errors never expose raw RPC details.

The [reviewed operating boundaries](signal-operating-boundaries.md) describe remaining recovery and timing limitations. A successful review does not mean there are no defects.

Record simulation uses 2,000,000 gas units; a hosted budget may authorize a signed limit up to 2,000,000 gas. The first record needs storage initialization; the Sepolia reference simulation estimated 970,165 gas before the signer's margin. Monetary ceilings, transaction counts, grant quotas and expiry remain independent limits. A higher gas-unit allowance does not refill or increase a publisher's monetary allocation.

The hosted signer adds 25% plus 10,000 gas to the estimate. With the maximum 2,000,000-gas budget, its effective estimate limit is 1,592,000; a smaller budget lowers that limit. API simulation is therefore not a promise that a hosted publisher will accept the transaction. A larger evaluator result can pass simulation but fail the signer's cost check before any reservation or broadcast. The Pulse reference's measured first-record estimate is below this bound. Fee and monetary limits can independently defer publication even when the gas estimate fits.

For that measured record, the signed limit is 1,222,706 gas. Even the maximum admissible 0.001 ETH transaction allowance requires `maxFeePerGas` at or below 817,858,095 wei (about 0.818 gwei); a smaller configured allowance lowers this ceiling. The signer checks the actual fee estimate against its allocation before reserving, signing or broadcasting. A `transaction_cost_limit` response does not increase the allowance: the hourly worker retains its bounded run and can retry while its original deadline permits.

The contract's 512-byte output limit is a byte bound, not a guarantee that every output fits the API or hosted gas allowance. Larger first records may exceed those gas bounds. The released Pulse evaluator returns 128 bytes; other reviewed evaluators must also fit the current chain's gas schedule and the publisher's actual budget.

Hosted allocations are operator configuration, admitted with `admitSignalPublisherBudget` from `adapters/signal-publisher.mjs`; they are not a public gas-credit endpoint. The host verifies the pinned configuration hash and trusts the operator's admission. An administrator with database and host-configuration access remains trusted. Budgets are immutable: changing a gas cap under the same ID fails. A new budget ID is a separate allocation, so an operator must retain and account for old spending and reservations and retire the old allocation explicitly. A gas-only correction must not silently duplicate the monetary allowance or reset used counters.
