# Reviews and contract changes

The intended chain is source → build → independent review → Claus decision → execution → verification. The review API is available to sponsor-approved pilots. Contract execution and automatic Claus decisions are not yet enabled.

## Submit a review

1. Create and explicitly publish a source snapshot, then compile it.
2. Call `review_create` with the completed `buildId`, public GitHub `repoUrl`, exact 40-character `baseCommit` and a stable `idempotencyKey`.
3. Poll `review_get`. The worker compares every source file at that commit with the snapshot before requesting a quote.
4. When `state` is `quoted`, inspect `quote.maximum`. Pilot projects pay zero; the sponsor reserves the actual provider ceiling. Call `review_accept` with the returned `quoteId` and a new stable acceptance key before the quote expires.
5. Poll the same case. `review_artifact` returns the completed report. `review_publish` explicitly adds its reference to the public project profile; it does not grant approval.

Required project permissions are `artifact.read`, `review.quote`, `review.admit` and `review.read`. Publication additionally requires `project.publish`. The source must remain public and the submitting credential valid until purchase. A workflow status of `failed` or `blocked` contains the specific reason. Status reads never buy another review.

An IMD audit currently costs at most 0.5 IMD within the supported profile. Price and terms are validated against each quote. Provider admission is purchased; a successful report or Claus approval is not guaranteed. Failed paid jobs retain their verified cost. Unknown payments are reconciled with the original order and are never automatically resent.

## Sponsor access

Registration is open; sponsorship is separate. The network owner's authenticated EOA session uses `review_pilot_get` and `review_pilot_set` to grant, change or revoke a project's eligibility. Grants expire within 30 days and use revision checks. The maximum per review cannot exceed the supported 0.5 IMD profile. Current admission allows two purchases per project and eight globally per UTC day, with at most one active paid review per project and eight globally. Fresh wallets do not create sponsor rights.

Project owners cannot grant themselves sponsorship, modify the sponsor balance or submit arbitrary transactions. The review wallet has finite funding and a finite Permit2 allowance, with no automatic refill. Its key is held by a separate worker; the API and compiler have no signing key.

## Contract review evidence

The initial [contract audit](https://api.imd.fun/jobs/016e8435-43ef-4f21-b18c-7dd290b796b2) covered commit `63e8dc823bd3ab242481b0b4b85f045e40fe369f`. Its specialists identified registration, delay and recovery issues. The fixes and retained assumptions are documented in [AUDIT_RESPONSE.md](https://github.com/contractclaus/claus-network-contracts/blob/aa865a79b447552d09d05244cfd958bb33254c12/AUDIT_RESPONSE.md).

The corrected commit `aa865a79b447552d09d05244cfd958bb33254c12` is under a separate [IMD review](https://api.imd.fun/jobs/bc2c40d4-b918-49c3-a376-c35a55c6c9a2). Its [0.5 IMD payment](https://etherscan.io/tx/0x8cd026b41094ae861b9115bd2f602594b18d4bdb32556321de8e5415f20d0d32) is confirmed. These two operator-initiated audits are distinct from the new public pilot workflow. Neither is described as a completed end-to-end pilot.

## Non-custodial contract profile

The candidate `ClausApprovalExecutor` and `ClausReadonlyProject` support one narrowly defined profile. The project calls its selected module with `STATICCALL`. It does not delegate arbitrary storage writes, custody user deposits, implement a tradable token or manage a liquidity pool.

A project owner registers an exact module and configuration. A later Claus approval binds the project, chain, executor, target, old version/code hash, new implementation/code hash, configuration, dependency snapshot, evidence, policy version/generation, authority generation, Claus signer generation, mandate, nonce, start time and expiry.

Execution checks the current bindings and required delay again. Owner revocation invalidates later operations. A delayed recovery path can rotate the Claus signer; its generation prevents old approvals from reviving after a signer is restored. The project's accepted minimum delay cannot be loosened through the owner policy setter. The minimum is one hour. Pending signer recovery pauses upgrades immediately; two-step project ownership changes invalidate previous authority and require a fresh mandate.

This profile does not establish that arbitrary future token, vault, credit or trading hooks are safe. New custody profiles need their own enforceable protection rules and review. Even static calls can depend on mutable external state.

## Verification records

Every deployed release must identify its chain ID, address, creation transaction, constructor input, compiler/settings, exact source, runtime comparison and explorer verification result. Implementation/admin relationships must also be disclosed where applicable.

No network contract deployment is claimed yet. A successful source match will be recorded separately from the review and approval. Source verification proves which code was deployed, not that the code is free of defects.
