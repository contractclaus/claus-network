# Compute funding allocation

This fixed trade program takes 0.1 percentage point from the existing 1.3% owner allocation. The direct owner allocation becomes 1.2%, and 0.1% accumulates as separate ETH claims for compute. The aggregate hook fee remains 2.3%. Buyback, platform and staking allocations, the separate pool fee, open transfers and the protected core are unchanged.

[Activation transaction](https://etherscan.io/tx/0x142580c758a4a0b4175bca23eaca429f0a3939116696e3eb550fbf3349e77d3b) · [Verified contract](https://etherscan.io/address/0x3dc1183ff95889359e00987b55d9164aad306762#code) · [Current fee state](https://claus.si/fee-state.json) · [Funding explanation](https://claus.si/read/Hooks/Funding)

The six quote buckets are `12000 / 3000 / 1500 / 2000 / 3500 / 1000` parts per million: direct owner, platform, buyback, staked LPs, staked NFTs and compute. Existing empty-staking fallbacks remain in the settlement core.

PoolManager credits the compute module directly during settlement. The quote and trade callback do not call an inference provider, bridge or oracle. Anyone may trigger redemption of this module's accumulated ETH claims, but the recipient is always the existing fixed owner wallet. There is no caller-selected recipient or arbitrary-approval method. `balances()` reports unclaimed ETH, and `totalClaimed()` records successful redemptions.

The initial contract deployment enabled revenue collection. The separate operating service described below now supports bounded conversion and funding. It does not enable a public inference gateway. Claims initiated by third parties still pay the fixed owner wallet; the operating service currently starts from unclaimed compute revenue.

The module uses the existing replaceable slot. Do not wrap it in the older `TreasuryProtectedProgram`: that adapter forces the direct owner bucket back to 13000, which would incorrectly add the compute allocation on top. The current installation service uses `ComputeProtectedProgram` to preserve the new split. The allocation itself is not an immutable part of the token core.

`deployment.json` records the deployed address and transaction evidence. `standard-input.json` contains the exact publishable Solidity input, without machine-local paths. Solidity 0.8.26, Cancun, optimizer 200 runs, via IR. Four focused contract cases and one same-state Ethereum fork comparison at block 26201191 passed; the fork comparison checked buy/sell outputs, fee allocation, redemption and module removal. The publishable build changes compiler metadata only; executable runtime matches the tested candidate.


## Bounded operating conversion

The operating service uses only this designated compute revenue. It can claim at most 0.02 ETH per cycle, swap through the fixed ETH/USDC route, and transfer USDC to Base through Circle CCTP. A cycle can begin at most once per 24 hours, with a maximum of ten cycles and 0.2 ETH of revenue for this authorization. Ethereum gas is bounded at 0.001 ETH per cycle, Base gas at 0.0001 ETH per cycle using the existing extra-fee preflight estimate. The owner reserve is 0.90 ETH. Authorization ends on 14 November 2026 at 23:44:21 UTC, without automatic renewal.

Replenishment starts below 10 USDC of available payment authority or prepaid credit. Prepaid allocation targets 50 USDC, never exceeds 50 USDC per cycle, and is limited to the actual minted proceeds. Every step retains its original operation, nonce and transaction. An uncertain send is not replaced or repeated. Original holds and previous budgets are preserved.

The payer now reconciles prepaid funding against the original finalized USDC transfer and an authenticated provider ledger entry. A usable entry must identify that exact transaction, the credited amount and a unique credit ID. The database commits the credit and the spending allowance together, once per original cycle; a prepaid/cash split never counts the same proceeds twice. Repeated requests resume the saved history cursor and original payment.

Provider errors leave the original allocation held. An unreadable history stops before a new prepaid transfer; missing or ambiguous transaction references cannot be replaced with a balance increase or a disappearing pending deposit. No wallet login, manually supplied receipt or replacement deposit is required. The current account's last history response was 404, so a real provider-confirmed prepaid refill is still unverified. Existing inference works from its current resources. Public inference is not enabled by this service.

The existing schedule also reconciles original transaction receipts when the provider is unavailable or authorization for new spending has expired. This recovery path does not load a signing key. It cannot sign or send transactions, replace an unknown operation, or grant spending permission. New execution still requires the fixed authorized wallet. It records confirmed outcomes and releases the corresponding wallet lock; unresolved outcomes remain held. Provider errors are recorded as the current status, and expired spending authorization is reported as inactive.

Future reviewed programs use the [compute-preserving adapter](../trade-programs/ComputeProtectedProgram.sol). The fixed deployed collector and current onchain fee state remain available at [Claus fee state](https://claus.si/fee-state.json).


## Private operating status

The authenticated payer resource endpoint and Claus' existing `network_care` economics reader now include `computeFunding`. It reports admission for the designated-compute service from its actual configuration and bounded approval: enabled or disabled, expiry, policy identity and required prepaid-credit verification. It is re-read independently of the short balance cache. This is read-only configuration status, not a transfer, grant, completed funding cycle or provider credit receipt. Missing status remains unavailable while successful balance reads are retained.

For existing version-1 clients, `automaticFundingEnabled: false` is retained with `automaticFundingScope: manual_cash_topup_proposal`. That field describes only the old non-executable cash proposal. Read `computeFunding.enabled` for the separate compute service. Existing callers do not need a runtime restart.

[Resource reader source](./operating-resources.js), retained in payer `dpl_48AefcKDcqbzWRfCCLtw7RziJCdz`. The runtime, wallet destinations, approval, limits and schedule are unchanged. Current inference continues from existing resources; a future prepaid refill still needs its attributable provider receipt.
