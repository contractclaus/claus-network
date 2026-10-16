# Reviews and contract changes

The workflow is source → build → independent review → Claus decision → execution → verification. Eligible public projects can request sponsored reviews within the current funded allocation. The protected readonly profile is available on [Sepolia](testnet.md) and [Ethereum](mainnet.md); actual release evidence and remaining exclusions are recorded in [release status](release-status.md).

## Submit a review

1. Create and explicitly publish a source snapshot, then compile it.
2. Call `review_create` with the completed `buildId`, public GitHub `repoUrl`, exact 40-character `baseCommit` and a stable `idempotencyKey`.
3. Poll `review_get`. The worker compares every source file at that commit with the snapshot before requesting a quote.
4. When `state` is `quoted`, inspect `quote.maximum`. Eligible sponsored projects pay zero; the sponsor reserves the actual provider ceiling. Call `review_accept` with the returned `quoteId` and a new stable acceptance key before the quote expires.
5. Poll the same case. `review_artifact` returns the completed report. `review_publish` explicitly adds its reference to the public project profile; it does not grant approval.

Required project permissions are `artifact.read`, `review.quote`, `review.admit` and `review.read`. Publication additionally requires `project.publish`. The source must remain public and the submitting credential valid until purchase. A workflow status of `failed` or `blocked` contains the specific reason. Status reads never buy another review.

`public_review` retrieves the stored report at `GET /v1/public/reviews/{caseId}` without a credential, only while the review, its source and its project profile are published. The response contains the original report text, provider job ID, report hash and artifact hash. It excludes payment and provider-internal job data. Withdrawing any of those publications stops subsequent reads. Previously retrieved copies cannot be recalled.

Explorer report links serve that stored text, so reading a completed report does not depend on the provider's Markdown endpoint being available. Reports reconstructed from an accepted IMD submission retain their original provenance notice and `accepted-audit-submission` source kind. This availability mechanism does not create a new review or turn findings into approval.

An IMD audit currently costs at most 0.5 IMD within the supported profile. Price and terms are validated against each quote. Provider admission is purchased; a successful report or Claus approval is not guaranteed. Failed paid jobs retain their verified cost. Unknown payments are reconciled with the original order and are never automatically resent.

## Sponsor access

Registration is open; sponsorship is separate and requires an active public sponsor policy with available funding and quota. The network owner manages versioned public admission through the documented policy operations. Legacy `review_pilot_get` and `review_pilot_set` grants remain separate. The maximum per review cannot exceed 0.5 IMD. Current admission allows two purchases per project and eight globally per UTC day, with at most one active paid review per project and eight globally. A new wallet does not create a guaranteed subsidy.

Project owners cannot grant themselves sponsorship, modify the sponsor balance or submit arbitrary transactions. The review wallet has finite funding and a finite Permit2 allowance, with no automatic refill. Its key is held by a separate worker; the API and compiler have no signing key.

## Contract review evidence

The initial [contract audit](https://api.imd.fun/jobs/016e8435-43ef-4f21-b18c-7dd290b796b2) covered commit `63e8dc823bd3ab242481b0b4b85f045e40fe369f`. Its specialists identified registration, delay and recovery issues. The fixes and retained assumptions are documented in [AUDIT_RESPONSE.md](https://github.com/contractclaus/claus-network-contracts/blob/b03d144a1c9f07055676066b960c1415af278394/AUDIT_RESPONSE.md).

The corrected commit `aa865a79b447552d09d05244cfd958bb33254c12` has a separate [IMD review](https://api.imd.fun/jobs/bc2c40d4-b918-49c3-a376-c35a55c6c9a2). Its [0.5 IMD payment](https://etherscan.io/tx/0x8cd026b41094ae861b9115bd2f602594b18d4bdb32556321de8e5415f20d0d32) is confirmed.

The retained legacy executor uses commit `2594aa2dd8285736c7b60fdf31e05095e6ff21dc`. It addresses further specialist findings: recovery cancellation invalidates interim approvals, suspended signers cannot cancel project approvals, invalid module targets are rejected before queueing, and the previous implementation is checked against its stored code commitment. Its [completed IMD review](https://api.imd.fun/jobs/86d47bf6-5134-4652-b268-b488e4bbc1c0), submitted through the pilot API, has four low and six informational findings, with none rated medium or higher. Acceptance covers only the restricted noncustodial Sepolia profile and its [retained trust boundaries](testnet.md#retained-trust-boundaries). The [source and response](https://github.com/contractclaus/claus-network-contracts/tree/50d0e42ca5a9b0ee362cac5da12c64d020b9323d) identify that exact version.

The first two operator-initiated audits are distinct from the public pilot workflow. None of these individual reports alone demonstrates a completed end-to-end pilot.

## Non-custodial contract profile

`ClausApprovalExecutor` and `ClausReadonlyProject` support one narrowly defined profile. The project calls its selected module with `STATICCALL`. It does not delegate arbitrary storage writes, custody user deposits, implement a tradable token or manage a liquidity pool.

A project owner registers an exact module and configuration. A later Claus approval binds the project, chain, executor, target, old version/code hash, new implementation/code hash, configuration, dependency snapshot, evidence, policy version/generation, authority generation, Claus signer generation, mandate, nonce, start time and expiry.

Execution checks the current bindings and required delay again. Owner revocation invalidates later operations. A delayed recovery path can rotate the Claus signer; its generation prevents old approvals from reviving after a signer is restored. The project's accepted minimum delay cannot be loosened through the owner policy setter. The active replacement executor has no mandatory minimum; zero permits execution after a valid approval without an upgrade wait. New admitted Sepolia registrations use that executor. Existing projects retain their original executor and accepted delay. Queue and execution may occur in the same transaction when the delay is zero, so there is no reaction window between them. Pending signer recovery pauses upgrades immediately; two-step project ownership changes invalidate previous authority and require a fresh mandate.

This profile does not establish that arbitrary future token, vault, credit or trading hooks are safe. New custody profiles need their own enforceable protection rules and review. Even static calls can depend on mutable external state.

## Verification records

Every deployed release must identify its chain ID, address, creation transaction, constructor input, compiler/settings, exact source, runtime comparison and explorer verification result. Implementation/admin relationships must also be disclosed where applicable.

The [deployment manifest](deployments.json) records the verified Sepolia executor and reference project wallet, including their creation transactions, constructor inputs and compiler settings. The protected-change workflow still requires its own decision, execution and finality evidence; see [release status](release-status.md). Source verification proves which code was deployed, not that the code is free of defects.

The retained earlier zero-delay replacement is pinned to commit `bc642d36d5eafffcd04859574219acfa7a3bb27d`. Its [independent assessment](reference-zero-delay-review.json) records every finding and the accepted Sepolia scope. The [activation receipt](reference-zero-delay.json) distinguishes deployed code, source verification and capability adoption. A nonzero `readyAt` alone does not prove an approval is still valid: nonce cancellation, current authority, signer generation, expiry and exact code must also be checked.


New admitted Sepolia registrations now use the bounded-result executor from commit `af8cf6370d5b3893fa5b38df251d4b27b5db5f8d`, which preserves zero-delay support and bounds return data before allocation. Its [kernel receipt](reference-public-kernel.json) records independent review, verified code and actual adoption. Existing bindings remain unchanged. Public admission now has a separate finite operating policy; see the completed references and live capabilities in [release status](release-status.md).


### Public admission failure handling

Version 0.11.3 returns unused lifetime sponsorship for a cancelled review only if no payment was submitted. The daily attempt limit is still consumed. Uncertain submitted payments preserve their original reservation and request ID. For public contract work, use a delegated agent for module deployment, registration submission and proposals. The owner authenticates to prepare and sign registration. Expired pilot projects must satisfy the current public admission policy and its gas ledger; old executor bindings are not automatically migrated. See [operations](operations.md#public-admission-failure-boundaries) for the finite decision and gas limits.

## Stateful contract proposal

A [managed-contract candidate](https://github.com/contractclaus/claus-network/tree/main/proposals/managed-contracts) separates arbitrary project storage from its Claus-controlled implementation registry. It is not admitted or deployed. Current public contract operations continue to use the reviewed readonly profile. A general proxy does not make all future changes safe; a new profile requires independent review, API and agent integration, and a demonstrated release.


## Claus native trade-program reviews

`claus-native-program-v1` is a separate Ethereum review profile for Claus’ own authenticated network identity. It is not available to arbitrary projects, does not change the existing read-only or managed profiles, and does not authorize the public `module_deploy` endpoint. Published immutable source and a completed build are required; existing review funding limits, original job identities and paid-outcome reconciliation still apply.

The native program must implement the fixed `quote` and `onTrade` interfaces. The initial installer accepts zero-argument constructors; constants and dependencies belong in the reviewed source. Interface validation is not a security approval. An independent report must finish, its source and build must match, and Claus must assess the actual report before requesting installation through the separate fixed signer. A completed review alone never changes the coin.

The installer preserves the permanent core and uses `ComputeProtectedProgram`: 1.2% goes to the existing owner recipient and 0.1% to the fixed compute collector, replacing the former 1.3% direct-owner allocation. Compute funding adds no fee. Other fee buckets remain bounded by the existing aggregate 15% main-pool cap. The [program adapter reference](https://github.com/contractclaus/claus-network/tree/main/reference/trade-programs) contains the current source; the older `TreasuryProtectedProgram` is historical and must not wrap the compute collector. Removing a program selects the existing compute collector.

The installer accepts no arbitrary wallet recipient, approval, signature or value-bearing transaction. Deployment and source verification precede selection. Stateful callbacks use canonical receipts bound to the original program, even after a later program change. Existing pending outcomes retain their original identifiers.
