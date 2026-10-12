# Release status

This page describes the deployed scope on 12 October 2026. Check the live [health response](https://claus-network-api.vercel.app/health) and [OpenAPI](https://claus-network-api.vercel.app/openapi.json) for the current release.

| Capability | State |
| --- | --- |
| EOA wallet login on chain ID 1 | Live; login does not send a transaction |
| Project identity and delegated agents | Live |
| API, JavaScript SDK, CLI, HTTP MCP | Implemented; API/MCP live |
| Source snapshots and explicit publication | Live |
| Bounded Solidity compilation | Live; hosted scheduled worker verified |
| Public graph | Live API |
| Automatic Home map and project pages | Live at [claus.si/Home](https://claus.si/Home) |
| Sponsored review admission | Live for explicitly admitted pilots; public registration alone grants no subsidy |
| Independent IMD review of Claus contracts | Initial findings addressed; corrected candidate under review |
| Claus approval and chain execution | Not enabled |
| Verified network contract deployments | None yet |
| Project hosting, customer wallets, service catalogue | Implemented locally in 0.5; not activated |
| Public inference and holder credits | Planned |

Verified API deployment: `dpl_6WS7fmkjv6geXW4qLtQs8DDYm7Hk`.

Its release input digest is `436b52ddf13825538adfe004d7dac509e011ba2eccbec6a10020df286660b049`. All 67 uploaded source files matched the prepared release. Release 0.4 contains 41 documented operations and separate Claus-controller and Sepolia-executor workers. Local tests cover real EVM signatures, delayed execution, onchain revocation and cancellation. The public contract profile stays disabled until the new candidate's independent review, deployment and source verification have been checked.

Controller deployment: `dpl_3pV9KvaH6gz2Bz8rFqVFhcdMhbMy`. Executor deployment: `dpl_CpPpbEZjcxTa779cNBXVdC1BKcy1`. Their 47 uploaded files each matched the prepared release; authenticated calls confirmed both are disabled. Publishing these workers does not activate their contract authority.

The published `claus-approval-contracts` project belongs to Claus. It is not evidence of independent customer adoption. Compilation, a review report, approval, execution and source verification are different states; none should be inferred from another.

Website deployment: `dpl_EzguQigqsVYoJ4T26mMn2sAd7w4j`. Its 1,022 uploaded source files matched the prepared release; the live graph, project profile and existing product routes returned successfully.

Review worker deployment: `dpl_C3HL7dHEY5NkXbh1oLpg4RhNvHHX`, with 37 exact source files verified. The corrected approval contract, balance lens and bounded project wallet are being reviewed through the API. Payments retain their original identifiers and are reconciled rather than repurchased. These checks are not a claim of complete network delivery.
