# Ethereum contract profiles

API 0.13.9 supports the Ethereum readonly and bounded signal profiles within the owner-authorized finite operating allocation. The [deployment](mainnet-deployment.json) and [completed reference](reference-mainnet-contract.json) record actual verification, Claus approval, execution and revocation. Check live `capabilities` and `/health` before use; new admission closes when its allowance expires or is exhausted.

The supported profile is `claus-readonly-v1`: an independently reviewed module implementing `evaluate(bytes,bytes)`, bounded output, and a project contract whose implementation/configuration changes require the project's mandate and a genuine Claus decision. It accepts no deposits or arbitrary value transfers. The [signal profile](signals.md) adds a canonical Store and bounded publisher grants around the reviewed evaluator. [Contract intake](contract-intake.md) accepts supported configuration proposals on Mainnet. [Phase 3 evidence](reference-phase3.json) records the actual new flows. Tokens, wallets and vaults are not enabled by this release.

## Clients

Use the normal quickstart and review flow. When Mainnet is available, pass `chainId: 1` to `module_deploy`. Omit it for the compatible Sepolia default, `11155111`. The first deployment pins that project's chain; using another chain requires a separate project. Registration returns its exact EIP-712 domain. Sign that returned value; do not replace the chain ID or contract address. The delegated agent submits it and continues the usual proposal/status flow.

Transactions retain one original hash and nonce across outages. A reported execution requires a successful canonical receipt and Ethereum finality. Finality is consensus confirmation, not an imposed upgrade waiting period. The chosen zero upgrade delay remains zero. An unknown payment or dropped transaction is not treated as an unused budget.

The [source-verification limits](testnet.md) also apply on Ethereum. An unrecognized explorer status preserves its original GUID and can require operator attention, while other projects continue through the queue.

Deployment records retain the original audit source IDs. Their `publicSource` field links to the current Claus repository revision, with byte-identical compiler inputs checked against the deployed build. Repository history changes do not rewrite the original review or chain evidence.

## Historical readonly operator release procedure

The following records the original Phase 2 deployment. Phase 3 adds the [verified signal and intake contracts](https://claus.si/docs/contracts/SIGNAL_DEPLOYMENTS.json), separate bounded allocations and [signal review context](../integration/agent-signal-review.patch); it preserves those original executors and budgets.

The exact local release plan pins the public runtime commit, reviewed contract commit/build, constructor data, expected deployment address, roles and finite budgets. `integration/mainnet-release.mjs` supplies the guarded deployment and capability staging steps. Neither is exposed to clients. An owner approval must match the plan hash and an independent assessment must match its source/build and chain.

Release sequence:

1. Finish public Sepolia acceptance; assess the independent report on this source and the unchanged core contract together. Retain all limitations.
2. Obtain approval for the pinned plan. Snapshot databases, keys, signing journals and current runtime source using the existing encrypted recovery procedure.
3. Fund the separate Mainnet executor through the owner's existing shared signing journal, once under the plan's funding/gas ceilings. Never send the approval key or owner key to the API host.
4. Deploy the exact executor at nonce zero with `deployMainnetRelease`. Resume the same ID after interruption. Require finality, constructor/role readbacks, Etherscan verification and exact Sourcify creation/runtime matches.
5. Publish the chain-bound [agent review patch](agent-mainnet-review.patch) after checking its original SHA-256. The deployed schema hash is `1bd91bbbc15dd0c8352d791ea02c90b9d29c040dcd1d2913e135f7f8635fa42c`; it supersedes the earlier integration patch, names the actual chain and keeps vault-consumer evidence Sepolia-only. Deploy compatible API/controller/executor sources, retaining the existing Sepolia settings. API receives only `CLAUS_MAINNET_RPC_URL`; the controller receives its separate approval key and the executor its separate transaction key through encrypted runtime environment settings. Each gets its own `CLAUS_MAINNET_SIGNER`. No Mainnet policy is active during deployment.
6. Verify exact deployed source, agent schema, fresh worker health including chain 1, and recovery. Stage the capability; publish and activate `chain_admission` with `chainId: 1` through the documented owner API. Its internal policy key is `chain.mainnet.admission`; usage is independent of Sepolia. Preserve existing Sepolia capabilities and all project bindings.
7. Run one fresh ordinary project through review, registration, real Claus decision, final execution and revocation. Publish its actual receipts and final recovery. The reference consumes the same approved pool. Do not label the operator's own client an independent user.

The initial authorized operating window is seven days with eight projects, 0.001 ETH maximum per transaction, 0.002 per project and 0.015 globally. Bootstrap is separately capped at 0.0046 ETH; owner funding gas at 0.0004 ETH. The plan also caps a bootstrap transaction at 30,000,000 gas; its 0.0046 ETH ceiling still applies. Estimate the exact creation against the current chain before funding. If fees or gas exceed either cap, execution waits or fails closed and requires a revised, explicitly approved allocation. Total new exposure is at most 0.02 ETH. These are maximum allocations, not current costs or a promise of perpetual service. No automatic refill. Review sponsorship uses only the existing authorized remainder and expiry, with no new IMD allocation implied.

## Pause and recovery

Disable the Mainnet admission policy through the same owner-only publish/activate operations, preserving generations, counters and reservations. Ordinary project reads, exports, owner revocation and reconciliation of already-broadcast work remain available. Leave compatible workers running for reconciliation. Do not roll back to Sepolia-only code while Mainnet jobs exist. A software rollback cannot undo a mined transaction or invalidate a distributed approval. The project owner can revoke onchain authority; the separately held recovery owner controls signer recovery after the constructor's 172800-second recovery delay. That recovery mechanism is distinct from the zero upgrade minimum.

No foreign contract terms, public inference keys, customer deposits or token-launch privileges are introduced.


The operator's approval file records the human authorization and exact plan hash in protected local storage. It is not an onchain signature or a credential accepted from API users. Its provenance is a trust boundary: an operator able to replace protected files or deployment code is already trusted. The release checks distinct approval, transaction and recovery addresses, the 172800-second recovery delay, stored exact verification evidence and the retained target artifact before staging.

Public decision limits share the operator's existing model allowance across both chains. Gas allocations remain separate. Mainnet activation does not create a second model allowance or guaranteed decision slots. If an unsent bootstrap expires or is revoked, its old journal remains terminal; a renewed release needs an explicitly approved new plan identity and the unchanged source review can be reused. No historical payment, nonce or reservation is reset.

The configured Mainnet RPC must serve historical contract state and event history, not only recent blocks. Verify it against the oldest relevant receipt and recovery range before admission. The same requirement applies to the separate Sepolia endpoint; see [historical RPC requirements](operations.md#historical-rpc-requirement-for-candidate-0124).
