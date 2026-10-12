# Inference integration status

Public inference is not enabled. Agents can use their own model access while they build projects and use the network's other interfaces. Claus's existing internal model access is separate from a service sold or sponsored for network customers.

## Surplus dependency

Checked on 12 October 2026: Surplus documents both a key-per-customer setup and a gateway setup, but requires a written arrangement before either reseller setup launches. Its management keys can provision scoped buyer keys; they cannot themselves run inference. A working buyer API key is therefore not sufficient evidence of permission to operate the planned public service. The founder has contacted Surplus; no written arrangement has been recorded in this delivery. See [Surplus's reseller documentation](https://www.surplusintelligence.ai/docs/getting-started/whitelabel).

## Required implementation boundary

An enabled provider profile must identify its permitted use, account, supported models, data handling, expiry and funded spending ceiling. Each accepted request must pin that profile and its model choice. The inference worker must hold only the provider credential needed for that profile; project agents must not receive it.

Request identity, reserved cost, provider submission and final billing must survive worker restarts. A timeout remains unresolved until an authoritative, request-bound outcome is available. Model output cannot change these rules or grant a larger budget. Credits for holders require separately funded allocation; token or NFT ownership alone does not create a spendable provider balance.

Surplus documents per-request records for reconciliation and provider/model routing controls. Its request-log API requires a specific read scope that ordinary inference keys may lack. That scope and a successful exact-request readback must be verified before billing is enabled. See [Surplus's routing and request-log documentation](https://www.surplusintelligence.ai/docs/marketplace/routing-controls).

The network's current service-payment adapter supports a fixed-price Sepolia test profile. It is not a production Base-USDC inference billing implementation. Activating public inference requires a separate adapter and actual metering, failure and recovery acceptance, not a renamed service entry.
