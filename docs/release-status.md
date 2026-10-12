# Release status

Status checked on 12 October 2026. The [live health response](https://claus-network-api.vercel.app/health) reports enabled capabilities separately from the [API schema](https://claus-network-api.vercel.app/openapi.json). Most paid and onchain workflows require an admitted pilot project.

| Capability | Current state |
| --- | --- |
| Owner login, private projects and delegated agents | Live; revocable access through API, SDK, CLI and MCP |
| Programmatic interfaces | API 0.10.1; 89 operations |
| Source snapshots and compilation | Live; explicit publication and bounded Solidity 0.8.27 or 0.8.26 compilation |
| Network explorer | [Home](https://claus.si/Home) and project pages update from explicitly published registry records |
| IMD reviews | Paid reference reviews completed; new work needs project admission and available sponsor funds |
| Claus approval and contract execution | Active for admitted Sepolia profiles; one genuine protected-change reference is finalized and published |
| Services, project wallets and isolated project UIs | Active for admitted pilots; the Claus-operated reference paid two services, changed agents and retired its payment sessions |
| Protected native vault | One owner-operated Sepolia reference; approved policy change finalized, deposit closure verified, original owner withdrawal successful and awaiting finality |
| Signed project transfers | Active for admitted projects; separate Claus-operated destination continued work with fresh grants |
| Contract request and callback | Verified Inbox and bounded dispatcher active for one Claus-owned Sepolia project; genuine end-to-end acceptance pending |
| Token launch | Not included in this public release |
| Public inference and holder credits | Disabled; provider permission, bounded billing acceptance and funding still required |
| Mainnet launches and customer deposits | Disabled; require the specific release and economic approval |
| Independent participant | Acceptance procedure ready; no independent participant has completed it |
| GitBook | Optional mirror; public source docs are available, GitBook account access is still required |

## Verified references

The [protected-change receipt](reference-lens.json) binds the genuine Claus decision, exact execution and finalized balance readback. The earlier rejected proposal remains part of the history; it was not converted into an approval.

The [collaboration receipt](reference-collaboration.json) records two paid service orders, an agent handover, a verified project wallet and retired payment sessions. The [published project](https://claus.si/p/claus-balance-explorer) appears on Home. The [transfer receipt](reference-portability.json) records continuation on a separate database and signing setup. Both operators and the reference services belong to Claus; these are engineering references, not independent adoption.

The [deployment manifest](deployments.json) records nine source-verified Sepolia contracts with creation transactions, runtime hashes and verification evidence. Source verification establishes which code is deployed; it is not a security audit. The [native-vault profile](native-vault.md) retains the scope and findings of its external reviews.

The [Inbox assessment](reference-inbox-review.json) retains all ten findings and accepts only the bounded owner-operated Sepolia pilot. The [activation receipt](reference-intake-activation.json) pins one project, its verified Inbox, separate dispatcher and finite 0.0002-Sepolia-ETH budget. The requester is a separate reference contract, outside that independent Inbox audit. The [client example](contract-intake.md#client-example) was exercised against actual local bytecode, with no public transaction or fabricated Claus decision.

## Release and recovery

API deployment: `dpl_6VgL7CJzx97GHvQeRR1VLhDwsArW`, release `a8f8354434ac8b191b77738f93772fed2f0861671c360a53a57cde1a11eefa52`. All 99 uploaded files matched the prepared release. The source suite passed 360 enabled tests with eight environment-specific skips. The separate local-EVM requester test passed. API 0.10.1 preserves compiler settings, original contract-result transactions and pending callbacks during [project export](portability.md); imports confer no active signing authority.

Both operator database snapshots were restored into disposable schemas and matched their original records, revisions and event sequences. The revoked credential remained denied. The encrypted remote bundle was read back, decrypted and compared. The [recovery receipt](reference-recovery.json) gives the checkpoint's actual date and coverage; later activity requires a newer checkpoint. It does not claim a production failover or continuous backup guarantee.

## Remaining production work


[Public inference](inference.md) has prepared interfaces and accounting but no activated customer provider. [Independent pilot acceptance](external-pilot.md) requires a real participant. Existing Club, staking, NFT rights, published payment history and existing pool fees are unchanged by this network release.
