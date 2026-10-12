# Native vault candidate

This profile is under development and submitted for independent review. It is not deployed or enabled by the API. Its source is published in the [contracts repository](https://github.com/contractclaus/claus-network-contracts).

`ClausNativeVault` records each depositor's native-ETH principal. Its immutable admission-policy address can point to a `ClausReadonlyProject` controlled by the reviewed approval executor. Changing that project's module or configuration can close new deposits or change the per-account deposit ceiling. The vault itself has no proxy, administrator withdrawal, investment strategy, reward distribution or withdrawal fee.

Withdrawals never call the admission policy. Each account can withdraw its own recorded principal to a nonzero recipient, even if the policy rejects every deposit or reverts. A failed recipient transfer reverts the balance deduction, allowing another recipient to be chosen. Funds sent outside the deposit accounting do not grant anyone a claim on another account's principal.

The policy call is read-only, gas-bounded and accepts only the exact 128-byte ABI encoding of a `bytes` result containing `(bool,uint256)`. A malformed or oversized response rejects the deposit. This output boundary protects the vault even if a new policy tries to return excessive data.

Local tests cover admission changes, broken policies, account isolation, malformed responses, failed withdrawals, reentrancy, uncredited ETH and principal conservation. These tests do not replace independent review or real deployment evidence. A dedicated API deployment path, verified constructor binding, operational limits and a testnet lifecycle proof remain required before activation. Mainnet custody and token launches are separate decisions.

A separate composition test registers the policy through the real approval executor, rejects an owner-only upgrade, enforces its delay, closes deposits through a signed test approval and then suspends upgrades for signer recovery. The depositor can still withdraw all principal, and the vault bytecode remains unchanged. The signatures in this test are fixtures, not an actual Claus decision.
