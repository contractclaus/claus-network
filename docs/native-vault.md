# Native vault candidate

The external vault report is assessed for a restricted Sepolia profile, with no medium or higher findings. The separate admission-policy review is still pending. The profile is not activated. Its API and isolated worker are deployed, with new vault deployments disabled. Its source is published in the [contracts repository](https://github.com/contractclaus/claus-network-contracts).

`ClausNativeVault` records each depositor's native-ETH principal. Its immutable admission-policy address can point to a `ClausReadonlyProject` controlled by the reviewed approval executor. Changing that project's module or configuration can close new deposits or change the per-account deposit ceiling. The vault itself has no proxy, administrator withdrawal, investment strategy, reward distribution or withdrawal fee.

Withdrawals never call the admission policy. Each account can withdraw its own recorded principal to a nonzero recipient, even if the policy rejects every deposit or reverts. A failed recipient transfer reverts the balance deduction, allowing another recipient to be chosen. Funds sent outside the deposit accounting do not grant anyone a claim on another account's principal.

The policy call is read-only, gas-bounded and accepts only the exact 128-byte ABI encoding of a `bytes` result containing `(bool,uint256)`. A malformed or oversized response rejects the deposit. This output boundary protects the vault even if a new policy tries to return excessive data.

Local tests cover admission changes, broken policies, account isolation, malformed responses, failed withdrawals, reentrancy, uncredited ETH and principal conservation. These tests do not replace independent review or real deployment evidence. The dedicated API path and constructor checks are implemented and locally tested; independent review assessment, hosted worker activation and a public testnet lifecycle proof remain required. Mainnet custody and token launches are separate decisions.

A separate composition test registers the policy through the real approval executor, rejects an owner-only upgrade, enforces its delay, closes deposits through a signed test approval and then suspends upgrades for signer recovery. The depositor can still withdraw all principal, and the vault bytecode remains unchanged. The signatures in this test are fixtures, not an actual Claus decision.

## Interface

API 0.7 exposes `vault_create`, `vault_get`, `vault_transaction` and `vault_balance` through the same API, SDK, CLI and MCP. Their presence does not activate the contract profile. Deployment requests remain gated by the separately controlled capability.

`vault_create` requires `vault.manage`, sponsor admission and a previously verified policy registration explicitly admitted for that project. It deploys only the operator's exact reviewed vault artifact. Concurrent calls share one job, and an uncertain broadcast keeps its original transaction. Admission pins the complete registration binding, module address and runtime hash, and the reviewed 64-byte configuration profile. A changed artifact, review, policy binding, withdrawn admission or revoked mandate prevents a new broadcast. The worker also checks the live implementation and configuration before signing. These checks do not stop later valid governance updates; the vault’s independent withdrawal path remains the protection for principal.

`vault_transaction` requires `vault.read` and returns calldata for either `deposit` or `withdraw`; it never signs or sends a depositor's transaction. `amountWei` is an exact integer string. A withdrawal also supplies `recipient`. No recipient is accepted for a deposit. The caller's wallet owns the resulting principal claim. The fixed contract and its immutable policy binding are checked before returning calldata.

Disabling sponsored deployment does not disable reading a withdrawal transaction. Direct contract withdrawals need neither this API nor an active network mandate. `vault_balance` returns principal at a named finalized block; it does not mistake pending deposits for finalized funds.

## Reviewed limits

The assessed pilot uses exactly `ClausVaultAdmission` with its 64-byte `(bool,uint256)` configuration. The fixed 250,000-gas policy call does not support every 8,192-byte configuration accepted by the general read-only kernel. Large configurations or another admission module require a new profile assessment and measured gas bounds. Failure closes deposits while preserving withdrawals.

Deposits use an explicit `deposit()` call with estimated gas. Solidity `transfer()` and `send()` with the 2,300-gas stipend are not supported deposit paths. The host verifies the policy's project identity, executor and code hash before deploying; the vault constructor alone does not certify timelocked governance.

## Policy-review context

The review-context implementation now includes a registered vault as a consumer of its policy. Evidence contains the complete native-vault compiler artifact, the separate IMD report, deployed runtime, immutable policy address and principal observations from the same finalized block as the policy evidence. The runtime comparison substitutes the actual constructor policy into every compiler-declared immutable position, then compares the entire runtime. A changed consumer blocks both a fresh model request and protected execution of an older proposal.

Claus's additional review scope is limited to the owner-operated Sepolia pilot: the observed total principal must equal the recorded owner's principal and be at most 1,000,000,000,000 wei. The model must assess the downstream withdrawal path as well as the proposed admission change. This snapshot is not a guarantee that no new deposits occur later; permanent withdrawal protection comes from the vault code. Consumers outside the registry are not covered by the review.

Complete source and both compiler artifacts can exceed the original small review envelope. The bounded review input accepts up to 900,000 bytes; it retains the same per-request inference-payment ceiling and response limit. The release status and deployment receipts determine whether this implementation is live. Local compatibility or a valid envelope alone is not a model approval.
