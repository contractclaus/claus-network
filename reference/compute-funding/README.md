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

Replenishment starts below 10 USDC in the fixed Base operating wallet or below 10 USDC of remaining payment authority. The proceeds stay in that wallet and can pay directly through x402. This wallet-funding service does not make new Surplus prepaid deposits or depend on the provider's deposit-history API. The destination is `0xa46a89b5b3504c1c999696de8173ec9b2eb0a01a` on Base (chain 8453); it cannot be replaced by a caller.

Every step retains its original operation, nonce and transaction. The original finalized CCTP mint receipt proves the credited amount in the operating wallet. The database records that receipt and extends the bounded spending allowance atomically, once; an uncertain send remains held. Existing holds, limits and earlier prepaid evidence are retained. A wallet balance is not presented as proof of a newly completed funding cycle.

Existing prepaid inference keeps using its present credit. The former prepaid-reconciliation code and history are retained for recovery; this change does not claim that a Surplus credit was verified or that its history endpoint has been repaired. Public inference is not enabled by this service.

The existing schedule also reconciles original transaction receipts when authorization for new spending has expired. This recovery path does not load a signing key. It cannot sign or send transactions, replace an unknown operation, or grant spending permission. New execution still requires the fixed authorized wallet. It records confirmed outcomes and releases the corresponding wallet lock; unresolved outcomes remain held. Funding errors are recorded as the current status, and expired spending authorization is reported as inactive.

Future reviewed programs use the [compute-preserving adapter](../trade-programs/ComputeProtectedProgram.sol). The fixed deployed collector and current onchain fee state remain available at [Claus fee state](https://claus.si/fee-state.json).


## Private operating status

The authenticated payer resource endpoint and Claus' existing `network_care` economics reader now include `computeFunding`. It reports admission for the designated-compute service from its actual configuration and bounded approval: enabled or disabled, expiry, policy identity, payment rail and fixed wallet destination. It is re-read independently of the short balance cache. This is read-only configuration status, not a transfer, grant, completed funding cycle or provider credit receipt. Missing status remains unavailable while successful balance reads are retained.

For existing version-1 clients, `automaticFundingEnabled: false` is retained with `automaticFundingScope: manual_cash_topup_proposal`. That field describes only the old non-executable cash proposal. Read `computeFunding.enabled` for the separate compute service. Existing callers do not need a runtime restart.

[Resource reader source](./operating-resources.js), used by the payer. This release changes the funding rail to the fixed operating wallet; numerical limits, the existing expiry, recipients and schedule are retained. Current inference continues from existing resources. The first new automatic wallet refill is only established when its original onchain receipts are recorded.
