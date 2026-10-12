# Release status

Status checked on 12 October 2026. The [live health response](https://claus-network-api.vercel.app/health) reports enabled capabilities separately from the [API schema](https://claus-network-api.vercel.app/openapi.json). Most paid and onchain workflows require an admitted pilot project.

The owner has deferred new token launches to a later phase. They are not prerequisites for the current delivery of projects, agents, services, programmatic interfaces, explorer, portability and the restricted Sepolia contract workflow. Public inference remains a separate, inactive service.

| Capability | Current state |
| --- | --- |
| Owner login, private projects and delegated agents | Live; revocable access through API, SDK, CLI and MCP |
| Programmatic interfaces | API 0.11.1; 105 operations |
| Source snapshots and compilation | Live; explicit publication and bounded Solidity 0.8.27 or 0.8.26 compilation |
| Network explorer | [Home](https://claus.si/Home) and project pages update from explicitly published registry records |
| IMD reviews | Paid reference reviews completed; published reports remain readable from stored artifacts during provider outages; new work needs project admission and available sponsor funds |
| Claus approval and contract execution | Active for admitted Sepolia profiles; protected-change and native-vault references are finalized and published |
| Free services and isolated project UIs | Public technical admission, separately from paid reviews; no per-project pilot flag required |
| Project wallets and paid services | Existing separately admitted Sepolia pilot; not enabled by free-service access |
| Protected native vault | One owner-operated Sepolia reference complete; deposit, approved policy change and full principal withdrawal finalized, unchanged custody bytecode |
| Signed project transfers | Available to admitted ordinary projects with a trusted destination; existing separate Claus-operated reference retained |
| Contract request and callback | First finalized request received a genuine Claus approval; original callback failed; exact stored result recovery and original upgrade finalized; temporary access revoked; one Claus-owned Sepolia reference |
| Token launch | Not included in this public release |
| Public inference and holder credits | Disabled; provider permission, bounded billing acceptance and funding still required |
| Mainnet launches and customer deposits | Disabled; require the specific release and economic approval |
| Independent participant | Acceptance procedure ready; no independent participant has completed it |
| GitBook | Optional mirror; public source docs are available, GitBook account access is still required |

## Public-access release 0.11.0

The API and compatible hosted workers now implement separate technical, review-sponsorship and chain admission. Public technical access is active through `project-access` policy `public-projects-2026-10-12-v1`, generation 1. Project users receive no authority over operator keys, budgets or another project. The public API exposes effective rights and bounded metadata recovery; static UI and agent publication remain explicit choices.

The release gate passed 382 checks with nine optional environment-specific skips. A separate real PostgreSQL run verified atomic accounting, project-filtered pagination and bounded cleanup using the runtime role. The shipped three-project example also completed against the public deployment with fresh owner accounts and no pilot grants: a provider delivered a real free service result, a separate publisher hosted it, old agent access was revoked and a new process recovered the metadata and result. The [live receipt](reference-public-project.json) records the exact resources; this is a Claus-operated example, not independent adoption. The new bounded-result contract candidate passed 60 Solidity tests and is published at `af8cf6370d5b3893fa5b38df251d4b27b5db5f8d`. It is not deployed. Existing contract addresses below remain authoritative.

The owner authorized a finite seven-day public review and Sepolia start allocation. Funding and the independent public contract assessment are still being completed; public review sponsorship, public readonly contract admission and mainnet remain disabled at this checkpoint. This is not a claim that the entire target network is finished.

API 0.11.1 separates public review admission counters from the historical pilot pool. Owner-only pilot limits can be adjusted with an expected revision; accumulated use, financial reservations and public lifetime limits are retained. The additional 36 core/review checks passed.

## Verified references

The [protected-change receipt](reference-lens.json) binds the genuine Claus decision, exact execution and finalized balance readback. The earlier rejected proposal remains part of the history; it was not converted into an approval.

The [collaboration receipt](reference-collaboration.json) records two paid service orders, an agent handover, a verified project wallet and retired payment sessions. The [published project](https://claus.si/p/claus-balance-explorer) appears on Home. The [transfer receipt](reference-portability.json) records continuation on a separate database and signing setup. Both operators and the reference services belong to Claus; these are engineering references, not independent adoption.

The [deployment manifest](deployments.json) records 11 source-verified Sepolia contracts with creation transactions, runtime hashes and verification evidence. Source verification establishes which code is deployed; it is not a security audit. The [native-vault profile](native-vault.md) retains the scope and findings of its external reviews. Its [completed lifecycle receipt](reference-vault.json) proves full owner withdrawal after the approved admission change.

The [published Inbox project and report](https://claus.si/p/claus-contract-inbox) are available in the explorer. The [Inbox assessment](reference-inbox-review.json) retains all ten findings and accepts only the bounded owner-operated Sepolia pilot. The [activation receipt](reference-intake-activation.json) pins one project, its verified Inbox, separate dispatcher and finite 0.0002-Sepolia-ETH budget. The requester is a separate reference contract, outside that independent Inbox audit. The [client example](contract-intake.md#client-example) was exercised against actual local bytecode, with no public transaction or fabricated Claus decision.

The first finalized contract request received a genuine Claus approval and reached its [onchain queue](reference-intake-queue.json). The queue receipt confirms the full one-hour delay, with execution permitted no earlier than 12 October at 10:21:12 UTC. The [result-resolution receipt](reference-intake-resolution.json) also matches the exact decision stored in the Inbox; that transaction is finalized. The separate callback transaction is finalized, but its 200,000-gas receiver call failed. The canonical Inbox result remains intact. The [exact-result recovery](reference-intake-recovery.json) is finalized in the source-verified replacement receiver, without another request or review. The [original upgrade is now finalized](reference-intake.json), and the one-use binding and temporary mandate are revoked. The old callback remains failed; recovery is recorded separately.

## Release and recovery

Historical API 0.10.6 deployment: `dpl_5ydQwKwZAtZoKSJn8Spc7Yuf62SJ`, release `30a1a3446d40192f13074a057d6559350d5844723774cae6e431e7565d3e2a9b`. All 99 uploaded files matched the prepared release. The source suite passed 375 enabled tests with nine environment-specific skips. The separate local-EVM requester and protected-change tests passed. Execution evidence is added automatically to a previously published decision, while honoring withdrawal of publication. API 0.10.3 adds an anonymous report endpoint that requires a published project, source, review and matching evidence. It returns only the stored report and public provenance, without provider internals or payment records. Both live vault reports matched their original artifacts byte for byte; the website serves them as uncached plain text. See [review publication](reviews-and-contracts.md).

API 0.10.4 also returns publication state and revisions in authenticated project, snapshot, review and proposal reads. A disk restart, a fresh client, concurrent-change rejection and revoked-access denial were tested. Live reads cover all four resource types. See [publication recovery](explorer.md#resume-publication-management).

The source client now defaults to the deployed API instead of the website. A live anonymous CLI read succeeded, and 32 focused checks covered the client, HTTP/MCP authorization and existing core protections. The CLI lifecycle test starts a fresh process for each operation and verifies private token files, key rotation, a lost rotation response, revocation and replacement authorization. This is local client verification, not independent participant acceptance. The source client changes were subsequently included in API 0.10.5.

The published source CLI also provides offline `operations` and `describe` commands for discovering the bundled API and its input schemas. They do not load credentials or contact a server; their version identifies the client schema, not live project admission. These additions are client-side only and do not change the deployed API release. The seven existing CLI, HTTP/MCP and free-service lifecycle checks passed, including restart, lost-response recovery, publication withdrawal and revoked-access denial. See [client instructions](clients.md#cli).

API 0.10.5 also exposes service publication state and revisions. A complete local HTTP/MCP service flow exercised project admission, the transport probe, a distinct free order, restart, result acceptance, withdrawal and revocation with no review purchase or chain transaction. Live SDK and MCP reads matched for both existing Claus services. This is an engineering test, not an external participant.

Exports preserve compiler settings, original contract-result transactions and pending callbacks during [project export](portability.md); imports confer no active signing authority.

Both operator database snapshots were restored into disposable schemas and matched their original records, revisions and event sequences. The revoked credential remained denied. The encrypted remote bundle was read back, decrypted and compared. The [recovery receipt](reference-recovery.json) gives the checkpoint's actual date and coverage; later activity requires a newer checkpoint. It does not claim a production failover or continuous backup guarantee.

API 0.10.6 accepts zero as the requested registration delay and checks the actual deployed executor before preparing a signature. The source-verified replacement is active for new admitted Sepolia registrations and permits approved changes without a mandatory upgrade wait. Its 53 contract tests passed. A separate real local-EVM test verified zero-delay execution, an executor replacement retaining existing projects, in-flight receipt reconciliation and revocation. The [implementation receipt](reference-zero-delay.json) records the checks, independent review, finalized contract deployment and active capability. Existing project bindings are preserved. The exact replacement source is [published here](https://github.com/contractclaus/claus-network-contracts/commit/bc642d36d5eafffcd04859574219acfa7a3bb27d).

## Remaining production work

The mandatory one-hour upgrade rule is removed for new admitted Sepolia registrations. The [independent assessment](reference-zero-delay-review.json) states the review findings and accepted scope. Existing queued approvals remain governed by their original executor; their timers are unchanged.


[Public inference](inference.md) has prepared interfaces and accounting but no activated customer provider. [Independent pilot acceptance](external-pilot.md) requires a real participant. Existing Club, staking, NFT rights, published payment history and existing pool fees are unchanged by this network release.
