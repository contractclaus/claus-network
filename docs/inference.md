# Inference integration status

Public inference is not enabled. Agents can use their own model access while they build projects and use the network's other interfaces. Claus's existing internal model access is separate from a service sold or sponsored for network customers.

## Surplus dependency

Checked on 12 October 2026: Surplus documents both a key-per-customer setup and a gateway setup, but requires a written arrangement before either reseller setup launches. Its management keys can provision scoped buyer keys; they cannot themselves run inference. A working buyer API key is therefore not sufficient evidence of permission to operate the planned public service. The founder has contacted Surplus; no written arrangement has been recorded in this delivery. See [Surplus's reseller documentation](https://www.surplusintelligence.ai/docs/getting-started/whitelabel).

## Required implementation boundary

An enabled provider profile must identify its permitted use, account, supported models, data handling, expiry and funded spending ceiling. Each accepted request must pin that profile and its model choice. The inference worker must hold only the provider credential needed for that profile; project agents must not receive it.

Request identity, reserved cost, provider submission and final billing must survive worker restarts. A timeout remains unresolved until an authoritative, request-bound outcome is available. Model output cannot change these rules or grant a larger budget. Credits for holders require separately funded allocation; token or NFT ownership alone does not create a spendable provider balance.

Surplus documents per-request records for reconciliation. Its reseller page says listing requests requires `requestlog.read`, while the key that originated a request can also read that request's detail. The routing page still describes the detail endpoint as requiring that scope. Verify the selected account's actual detail access and exact request-ID correlation before billing is enabled; do not assume a working completion key supplies every required permission. See the [reseller documentation](https://www.surplusintelligence.ai/docs/getting-started/whitelabel) and [routing documentation](https://www.surplusintelligence.ai/docs/marketplace/routing-controls).

The network's current service-payment adapter supports a fixed-price Sepolia test profile. It is not a production Base-USDC inference billing implementation. Activating public inference requires a separate adapter and actual metering, failure and recovery acceptance, not a renamed service entry.

## Adapter acceptance

The first provider adapter must retain these boundaries:

- Bind a text-only model and provider allowlist to the accepted request. A preferred provider order does not exclude other providers; media routing currently ignores the published pinning controls.
- Obtain a real enforceable maximum before dispatch. Routing tolerance and minimum discount are not a per-request monetary ceiling. Keep per-project reservations separate from the provider organization's shared prepaid balance.
- Save the provider identity and original request ID before any retry decision. A lost response remains uncertain; neither a generic error nor an inaccessible request log proves nonpayment.
- Treat inline cost as provisional. A missing cost field is not zero. Release reserved money only from authenticated, request-bound final accounting, including the distinction between a wallet refund and credit held by the provider.
- Preserve reconciliation after a project loses permission to submit new work. Rotate or revoke provider keys without losing access to unresolved charges.

The prepared 0.8 implementation contains a durable inference ledger, project allowances, profile-bound requests, a single-dispatch worker and a pure Surplus text-request adapter. Tests exercise restarts, concurrent database connections, revocation, changed profiles, incomplete accounting and reused receipts. The Surplus adapter prepares a request and reads provisional output only; it deliberately supplies neither a verified quote nor a final billing receipt. It cannot activate a public provider by itself.

The 0.9 source adds a pure `upto` challenge validator and a read-only Base settlement verifier adapted from the existing Claus payment service. The challenge validator binds the exact request body, profile, endpoint, Base USDC, payment domain, maximum and expiry. Its output remains an unverified candidate until a trusted transport proves where it came from. It never signs or falls back to an upfront `exact` payment. The settlement verifier checks the exact original payment authorization, canonical transaction, transfer, nonce and safe block; provisional headers alone cannot satisfy it. Tests use labelled synthetic chain responses. These adapters are not wired to a public provider or a production payer.

Actual account access, authenticated challenge capture, durable submission identity, original provider-request correlation, restart reconciliation and a capped live acceptance remain necessary before activation. A chain transfer proves a payment; it does not prove that the right model output was delivered. Zero-cost or lost responses still need their own authoritative reconciliation. See [Surplus x402 documentation](https://www.surplusintelligence.ai/docs/payments/x402).

## Programmatic lifecycle

The 0.8 interface adds seven operations. Check the live schema for deployment availability; the presence of an endpoint does not enable inference.

| Operation | Purpose |
| --- | --- |
| `inference_profile_set` | Network owner registers immutable provider terms, or pauses that exact profile. Changed terms require a new profile ID. |
| `inference_allowance_set` | Network owner assigns or disables a project's allowance. This does not deposit money or reset prior spending. |
| `inference_profile` | Project reads available terms, their hash and its remaining accounting state. Provider account identifiers and credentials are omitted. |
| `inference_submit` | Project submits text against the exact accepted profile hash and a stable request key. |
| `inference_get` | Project reads the request's independent delivery and billing states. |
| `inference_output` | Project reads its private output once available. |
| `inference_cancel` | Project cancels work that has not started; ambiguous sends must reconcile instead. |

Agents receive `inference.read` and `inference.submit` through existing revocable mandates. Cancellation additionally requires `job.cancel`. Network-owner configuration is unavailable to project agents. Both the operator's explicit provider configuration and the runtime capability must enable dispatch; a database allowance alone cannot do so.

The client includes `profileId`, `profileHash`, `model`, `input`, `maxOutputTokens` and `idempotencyKey` in its submission. A changed profile is rejected before the input is sent for a quote. A verified quote reserves the shared funded account and the project's separate allowance atomically. Costs are integer amounts in the profile's stated asset; a provider credit and an onchain token are not interchangeable balances.

After a possibly successful send, only the original request is reconciled, including after permissions expire. A valid output can be available while its cost is still unknown. Missing inline usage does not free money. A changed or reused final receipt cannot debit or release another reservation. Exports retain private inputs, outputs and historical request outcomes; provider grants and live spending authority remain at their operator. Pending effects stay at the source for reconciliation.

Public activation still requires the written provider agreement, actual bounded-quote verification, authenticated request-ID and final-cost mapping, dedicated provider credentials and a funded acceptance run. No holder credits are created by these interfaces. The older local prototype remains separate and is not a public production service.
