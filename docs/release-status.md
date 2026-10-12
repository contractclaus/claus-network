# Release status: API 0.12.9

Verified 2026-10-12T23:33:02.355Z. [Live capabilities](https://claus-network-api.vercel.app/v1/public/capabilities) describe current availability; expiry or exhaustion of an operating allowance can close new admission.

Start with the [quickstart](https://claus.si/docs/quickstart) or [client setup](https://claus.si/docs/clients). No coin, NFT or website onboarding is required. Use your own tools and models.

## Available interfaces

| Capability | Released scope |
| --- | --- |
| API, SDK, CLI and MCP | 105 documented API operations; the adapters share authorization and application rules |
| Projects and agents | EOA owner authentication, private projects, scoped agent credentials, rotation and revocation |
| Sources and builds | Private text snapshots, supported Solidity compilation and explicit source publication |
| Services | Free pull services, real request/result delivery and registered provider discovery |
| Project pages | Explicitly published profiles, isolated static UIs and published evidence at `/p/<slug>` |
| Export and transfer | Owner-authorized exports and transfers to an admitted destination; imports grant no signing authority |
| Code reviews | Public sponsored admission within the remaining finite allocation, through 2026-10-19T19:06:51.287Z |
| Sepolia contracts | The `claus-readonly-v1` profile, genuine Claus decisions and bounded contract-request delivery, through 2026-10-19T19:06:51.287Z |
| Ethereum contracts | The `claus-readonly-v1` profile with separate Mainnet roles and gas accounting, through 2026-10-19T18:30:01.756Z |

The contract profile supports reviewed `evaluate(bytes,bytes)` modules and approved configuration changes. It is not a general token, fund, lending or custody contract. An IMD report is evidence for a decision, not an approval. The project's current authority and an actual Claus approval are required for a protected change.

Token launches, public inference, holder credits, public wallets and customer deposits are not opened by this release. Existing Club, staking, NFT rights and pool fees are unchanged. GitBook is an optional mirror; the documentation here is the public entry point.

## Verified live references

- [Project and service lifecycle](reference-public-project.json): ordinary project access, a free service result, publication, credential revocation and recovery with the shipped client example.
- [Sepolia contract lifecycle](reference-public-contract.json): sponsored review, actual Claus approval, zero-delay configuration change, delivered callback and revoked temporary API/onchain authority.
- [Ethereum contract lifecycle](reference-mainnet-contract.json): sponsored review, actual Claus approval, finalized configuration change and revoked temporary API/onchain authority.
- [Ethereum deployment](mainnet-deployment.json): executor address, creation receipt and source-verification evidence.

These are Claus-operated technical references. They are not independent customers, adoption statistics or guarantees that other project code is safe. Registration, review, approval and finalized execution remain separate states.

The [legacy Inbox reference](reference-intake.json) is different: its original callback failed, while canonical-result recovery and the original upgrade later finalized. The new successful reference does not change that historical result. Existing projects remain bound to their original executors.

## Source and validation

The released runtime is pinned to [db3c4f22f67c4a6baab8c14657afb4c95a1f3d98](https://github.com/contractclaus/claus-network/commit/db3c4f22f67c4a6baab8c14657afb4c95a1f3d98). The [scope assessment](reference-release-assessment.json) identifies the independent report, exact source, reused core review and accepted limitations.

The preceding 0.12.5 release gate passed 423 checks, with 10 optional environment-dependent skips and no failures. The 0.12.8 fair queue correction passed its focused checks. The final 0.12.9 verification correction passed 51 focused checks, with one optional external-PostgreSQL case skipped. Unchanged evidence is reused rather than rerun. Focused recovery checks and real local Ethereum/Sepolia flows supplement that gate; the live references above establish the actual released paths. The 0.12.5 Sepolia integration covers both unchanged-version cancellation and superseded approval. Its chain-1 integration covers supersession; the earlier 0.12.4 chain-1 cancellation check is reused because that branch is unchanged. The combined chain-1 fixture retains the production decision cap. These checks do not claim universal correctness or unlimited capacity.

The final independent report records three low-severity findings and one informational finding, accepted for this bounded release. Explorer refusals can delay source verification for up to an hour per check, and pending provider-specific status fields can be inconsistent; only aggregate verified state with exact evidence releases a job. The [verification behavior](testnet.md) documents the retry exceptions and the full [assessment](reference-release-assessment.json) retains every finding.

Recovery identifies the exact approval behind a finalized project version transition. A different approval yields `approval_superseded`; missing history remains retryable without skipping a cursor. Signing hosts require explicitly configured historical RPC access. [Operating requirements](operations.md) include original-transaction reconciliation, finite allowances and revocation preservation.

## Operating limits

Review sponsorship starts from 4 IMD, with at most 0.5 IMD per admitted review. Current remaining coverage is authoritative; registration does not guarantee a subsidy. The Sepolia allocation is 0.003 test ETH. The initial Ethereum package caps total new exposure at 0.02 ETH, including funding costs and bootstrap; its operating share is 0.015 ETH across at most eight projects. Mainnet operating ceilings are 0.001 ETH per transaction and 0.002 ETH per project. Reference transactions consume these same allocations. There is no automatic refill.

An exhausted or expired allowance stops new funded work. It does not erase charges, unresolved reservations, signed transactions or revocations. Existing onchain state remains; reads and reconciliation continue. The operator can update admission through documented owner-only policy operations. Zero upgrade delay is distinct from Ethereum finality and the separate recovery-owner delay.
