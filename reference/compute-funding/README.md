# Compute funding allocation

This fixed trade program takes 0.1 percentage point from the existing 1.3% owner allocation. The direct owner allocation becomes 1.2%, and 0.1% accumulates as separate ETH claims for compute. The aggregate hook fee remains 2.3%. Buyback, platform and staking allocations, the separate pool fee, open transfers and the protected core are unchanged.

[Activation transaction](https://etherscan.io/tx/0x142580c758a4a0b4175bca23eaca429f0a3939116696e3eb550fbf3349e77d3b) · [Verified contract](https://etherscan.io/address/0x3dc1183ff95889359e00987b55d9164aad306762#code) · [Current fee state](https://claus.si/fee-state.json) · [Funding explanation](https://claus.si/read/Hooks/Funding)

The six quote buckets are `12000 / 3000 / 1500 / 2000 / 3500 / 1000` parts per million: direct owner, platform, buyback, staked LPs, staked NFTs and compute. Existing empty-staking fallbacks remain in the settlement core.

PoolManager credits the compute module directly during settlement. The quote and trade callback do not call an inference provider, bridge or oracle. Anyone may trigger redemption of this module's accumulated ETH claims, but the recipient is always the existing fixed owner wallet. There is no caller-selected recipient or arbitrary-approval method. `balances()` reports unclaimed ETH, and `totalClaimed()` records successful redemptions.

This release collects revenue; it does not activate automatic conversion, bridging, Surplus deposits, a recurring spending allowance or a public inference gateway. An offchain funding process would need to account for original claim receipts, including claims initiated by third parties.

The module uses the existing replaceable slot. Do not wrap it in the older `TreasuryProtectedProgram`: that adapter forces the direct owner bucket back to 13000, which would incorrectly add the compute allocation on top. Future program composition must explicitly preserve the new split. This release does not make the compute allocation immutable across future replacements.

`deployment.json` records the deployed address and transaction evidence. `standard-input.json` contains the exact publishable Solidity input, without machine-local paths. Solidity 0.8.26, Cancun, optimizer 200 runs, via IR. Four focused contract cases and one same-state Ethereum fork comparison at block 26201191 passed; the fork comparison checked buy/sell outputs, fee allocation, redemption and module removal. The publishable build changes compiler metadata only; executable runtime matches the tested candidate.


## Bounded operating conversion

The operating service uses only this designated compute revenue. It can claim at most 0.02 ETH per cycle, swap through the fixed ETH/USDC route, and transfer USDC to Base through Circle CCTP. A cycle can begin at most once per 24 hours, with a maximum of ten cycles and 0.2 ETH of revenue for this authorization. Ethereum gas is bounded at 0.001 ETH per cycle, Base gas at 0.0001 ETH per cycle using the existing extra-fee preflight estimate. The owner reserve is 0.90 ETH. Authorization ends on 14 November 2026 at 23:44:21 UTC, without automatic renewal.

Replenishment starts below 10 USDC of available payment authority or prepaid credit. Prepaid allocation targets 50 USDC, never exceeds 50 USDC per cycle, and is limited to the actual minted proceeds. Every step retains its original operation, nonce and transaction. An uncertain send is not replaced or repeated. Original holds and previous budgets are preserved.

A confirmed transfer to Surplus is different from an attributable credit in its account ledger. The provider currently does not expose a usable per-deposit receipt through the documented history endpoint. Such a deposit remains held: it cannot start another cycle or increase spending permission. Aggregate balance growth does not complete it. This means automatic prepaid funding is not yet verified end to end. Public inference is not enabled by this operating service.

Future reviewed programs use the [compute-preserving adapter](../trade-programs/ComputeProtectedProgram.sol). The fixed deployed collector and current onchain fee state remain available at [Claus fee state](https://claus.si/fee-state.json).
