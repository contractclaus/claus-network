# Release status: API 0.13.9

Phase 3 verified 2026-10-13T18:39:05.932Z. Continuing operator policies activated on 13 October 2026; see the [maintenance record](reference-continuous-operation.json). [Live capabilities](https://claus-network-api.vercel.app/v1/public/capabilities) report current admission and expiry. [Quickstart](https://claus.si/docs/quickstart) · [Clients](https://claus.si/docs/clients) · [Public record walkthrough](pulse-walkthrough.md).

## Available scope

| Capability | Released scope |
| --- | --- |
| API, MCP, SDK and CLI | 121 shared API operations; no website, token or NFT required |
| Projects and agents | Owner authentication, scoped credentials, rotation, revocation and private sources |
| Free services | Pull providers, public-result publication and provenance for explicitly shared results |
| Project pages | Published profiles, isolated static UIs, service relationships and onchain feed evidence |
| Reviewed contracts | Existing readonly modules and genuine Claus approval for supported changes on Ethereum and Sepolia |
| Signal feeds | Canonical immutable Stores, signed publisher grants, quotas, expiry and revocation; versioned evaluator logic |
| Contract intake | Bounded asynchronous proposals for reviewed-module configuration, with a decision callback on Ethereum and Sepolia |

Data publication and logic upgrades are separate. A publisher can record data only within its signed grant; it cannot change evaluator logic. A protected logic update requires reviewed source, the current owner mandate and an actual Claus decision. The decision callback does not itself prove execution: execution has a separate finalized transaction.

Network review inference uses a separate 16,384-token reasoning-and-answer budget and high reasoning effort, independent of the conversation settings. The full model input and review criteria are unchanged. The [operator profile correction](reference-phase3-review-effort.json) is recorded separately from the independent audits. Ordinary requests keep their existing limit; the per-review payment ceiling stays at 2 USDC. The payment relay is activated before the agent so the larger requests are accepted throughout rollout. Native review responses now use the existing bounded streaming parser; see the [operator transport correction](reference-phase3-streaming.json). A streamed result retains its full payment reservation until independently matched billing evidence is available. The existing finite provider deadline still applies; an uncertain timeout retains its original hold and is not retried. [Correction and deployment evidence](reference-phase3-output-budget.json).

## Actual live evidence

[Network Pulse](https://claus.si/p/network-pulse) connects an [Observer](https://claus.si/p/network-pulse-observer), an [Evaluator](https://claus.si/p/network-pulse-evaluator) and a Consumer. These are three Claus-operated projects, not independent customers. They corroborate finalized chain data through two RPC sources, publish authorized results and record a bounded signal.

The [Phase 3 evidence](reference-phase3.json) records both chain lifecycles: version-1 publication, genuine Claus upgrade, version-2 publication, fresh MCP publication/reading, SDK/CLI readback and finalized grant revocation. It also records the actual Mainnet request, decision callback, separate execution and binding revocation, followed by a normal scheduled production run. [Source-verified contract addresses](https://claus.si/docs/contracts/SIGNAL_DEPLOYMENTS.json) bind compiler inputs and verification receipts.

Phase 1/2 evidence remains in the [historical release](release-status-0.12.9.md). The old Sepolia callback failure remains a failure; later successful flows do not rewrite it.

## Limits and review

The original Phase 3 API and publisher source is [ea60511243d7478572bee344a00a52ff4e9b01b1](https://github.com/contractclaus/claus-network/commit/ea60511243d7478572bee344a00a52ff4e9b01b1). The [continuing-operation maintenance record](reference-continuous-operation.json) identifies the newer per-role source pins. The original lifecycle evidence remains in the [Phase 3 record](reference-phase3.json). The [independent review assessment](reference-phase3-assessment.json) preserves the original review jobs, the gas-limit and decision-recovery corrections, and every finding disposition. Relevant API, scheduler, recovery and real local-EVM checks passed; the live receipts above establish the released paths. Unchanged earlier checks were reused.

Remaining recovery and timing findings are accepted within the [documented operating boundaries](signal-operating-boundaries.md). The gas correction also retains explicit [output, fee and operator-budget limits](signals.md#time-and-authority-boundaries); the assessment records every finding and its disposition. A finalized record proves acceptance by its Store, not the truth of external data. This is not a financial oracle or a guarantee that arbitrary project code is safe.

The [agent transport correction](agent-review-transport.patch) uses the existing ten-minute provider window for full-code review. Its caller remains bounded and its 2-USDC quote ceiling, model, exact review input, decision validation and no-duplicate recovery are unchanged. [Deployed agent evidence](reference-phase3-agent.json) and [transport checks](reference-phase3-transport.json) are separate from the contract and API source pins. The network review does not claim to be a complete independent audit of the agent or payment service.

The [status correction](agent-review-status.patch) prevents a negative status lookup from racing initial payment admission. Normal completion is saved by its original POST; recovery waits through the existing 800-second delivery window before querying an ID that may be fenced as absent. Streamed relay errors remain unresolved until their original payment status is reconciled. [The two reproduced failures and focused checks](reference-phase3-status-correction.json) cover those paths. Failed earlier requests remain failed in the evidence; no model decision or payment is invented for them.

The [shared-input correction](agent-review-shared-input.patch) sends identical Store and Factory compiler input once, with a fixed explicit reference. The complete original evidence and its hashes remain the approval input. [Lossless reconstruction checks](reference-phase3-shared-input.json) verify the representation. Long internal model reviews use the [bounded prepaid payment adapter](review-credit-routing.md); existing requests stay on their original payment route. [Deployment and checks](reference-phase3-credit-routing.json) bind the released source. Explicit one-day operator recovery allocations retain all prior attempts and the separate model budget; they do not grant automatic approval or unlimited retries.

Public data projects currently have at most 64 accepted free service orders per day. External publishers pay their own transaction gas. The Mainnet reference has two acceptance writes and at most 166 hourly production writes, ending 2026-10-20T00:46:01.737Z, with no automatic refill. The new Mainnet intake allocation is at most 0.003 ETH overall, 0.0006 ETH per project and 0.0003 ETH per transaction, under a continuing operator policy. These are ceilings, not observed costs. Existing spend is carried forward, not replenished.

Public review, readonly chain and signal admission now have no calendar cutoff (`expiresAt: null`). Their existing financial ceilings, daily quotas and revocation controls remain. The four-per-project and 32-global pilot decision cutoffs are disabled under the explicit continuous-operation capability; monetary and daily limits still apply. Consumed amounts and unresolved holds are not reset. Individual credentials, grants, approvals and transaction deadlines remain finite. The bounded Pulse reference above remains a separate finite workload.

The automatic data pipeline does not consume model credit. New contract reviews separately require available prepaid model credit, an admissible quote and review capacity. These balances are finite and are not refilled automatically; deployed review endpoints do not promise immediate admission. The payment adapter now accepts larger confirmed prepaid deposits within the existing operator budget. The 2-USDC quote ceiling remains; prepaid billing is trusted provider accounting, not a cryptographic per-request charge cap.

Token launches, public inference, holder credits, public wallets and customer custody remain unavailable. Existing CLAUS economics, Club, staking and NFT rights are unchanged.

A [stateful managed-contract candidate](https://github.com/contractclaus/claus-network/tree/main/proposals/managed-contracts) is proposed for independent review. It is not deployed or admitted. The public contract profile remains readonly.
