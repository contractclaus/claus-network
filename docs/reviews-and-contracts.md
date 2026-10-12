# Reviews and contract changes

The intended chain is source → build → independent review → Claus decision → execution → verification. Public review admission and contract execution are not enabled in the current API release.

## Initial independent review

The candidate repository is [claus-network-contracts](https://github.com/contractclaus/claus-network-contracts), commit `63e8dc823bd3ab242481b0b4b85f045e40fe369f`.

One IMD `audit` job is in progress: [016e8435-43ef-4f21-b18c-7dd290b796b2](https://api.imd.fun/jobs/016e8435-43ef-4f21-b18c-7dd290b796b2). Its 0.5 IMD [payment](https://etherscan.io/tx/0x116b6aa6bce7931d340ce2cc344be89f9d7f371e6f7eef09fe871ae2ea9819b0) is confirmed. Payment buys provider admission, not a guaranteed successful audit or a Claus approval.

The paid order's identity is retained through timeouts. Unknown outcomes are reconciled using the same order rather than purchasing a replacement. No new project is charged by the current release.

## Non-custodial contract profile

The candidate `ClausApprovalExecutor` and `ClausReadonlyProject` support one narrowly defined profile. The project calls its selected module with `STATICCALL`. It does not delegate arbitrary storage writes, custody user deposits, implement a tradable token or manage a liquidity pool.

A project owner registers an exact module and configuration. A later Claus approval binds the project, chain, executor, target, old version/code hash, new implementation/code hash, configuration, dependency snapshot, evidence, policy version/generation, authority generation, Claus signer generation, mandate, nonce, start time and expiry.

Execution checks the current bindings and required delay again. Owner revocation invalidates later operations. A delayed recovery path can rotate the Claus signer; its generation prevents old approvals from reviving after a signer is restored. The project's accepted minimum delay cannot be loosened through the owner policy setter.

This profile does not establish that arbitrary future token, vault, credit or trading hooks are safe. New custody profiles need their own enforceable protection rules and review. Even static calls can depend on mutable external state.

## Verification records

Every deployed release must identify its chain ID, address, creation transaction, constructor input, compiler/settings, exact source, runtime comparison and explorer verification result. Implementation/admin relationships must also be disclosed where applicable.

No network contract deployment is claimed yet. A successful source match will be recorded separately from the review and approval. Source verification proves which code was deployed, not that the code is free of defects.
