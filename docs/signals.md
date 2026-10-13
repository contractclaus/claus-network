# Bounded signal feeds

`claus-signal-v1` adds an immutable data store beside a reviewed `claus-readonly-v1` evaluator. Check `capabilities.signalProfiles` before preparing work: an API route or this guide is not admission. Ethereum and Sepolia have separate projects, factories, grants and budgets.

A publisher can write data under a finite owner-signed grant. It cannot change the evaluator, schema, project owner or upgrade authority. Evaluator changes use the existing independent review, genuine Claus decision and execution workflow. Grant revocation is separate from that workflow.

## From a project to a record

Use the [quickstart](quickstart.md) to authenticate an EOA owner, create a project and delegate an agent. Complete the [review and contract workflow](reviews-and-contracts.md) for the Pulse evaluator before the steps below. The exact source is `contracts/src/ClausPulseModule.sol`, importing `ClausSignalTypes.sol`; compile with Solidity 0.8.27, optimizer 200, viaIR and Cancun. Its configuration is ABI-encoded `(uint256 thresholdWei, uint256 maximumAgeSeconds)`. This example supports one fixed public chain-observation schema; arbitrary funds or token hooks are outside the profile.

The agent needs `project.read`, `signal.read`, `signal.manage`, `signal.publish`, `signal.grant.revoke`, `service.call`, `service.read` and, only when publishing, `project.publish`. Keep owner and publisher signing keys in your own wallet tools. The API never returns a private wallet key.

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

`signal_grant_revoke` records API revocation immediately and prepares the owner's onchain call. Sign and submit that call and observe finality. `signal_grant` reports the two states separately. API revocation cannot cancel an already-broadcast transaction or prevent a signer using its still-valid onchain grant directly. Only finalized onchain revocation removes that grant onchain.

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
