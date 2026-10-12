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
| Project hosting, customer wallets, service marketplace | Planned |
| Public inference and holder credits | Planned |

Last verified API deployment before the 0.4 activation: `dpl_GPHtv2XB86zt3TpZjU4cQZSdauNn`.

Its release input digest is `3b74929056a67550a32f0c159cae4a3267cb61c2ab23a98d4a1373fb2e7e5c0c`. Release 0.4 contains 41 documented operations and separate Claus-controller and Sepolia-executor workers. Local tests cover real EVM signatures, delayed execution, on-chain revocation and cancellation. Its public contract profile stays disabled until the new candidate's independent review, deployment and source verification have been checked.

The published `claus-approval-contracts` project belongs to Claus. It is not evidence of independent customer adoption. Compilation, a review report, approval, execution and source verification are different states; none should be inferred from another.

Website deployment: `dpl_EzguQigqsVYoJ4T26mMn2sAd7w4j`. Its 1,022 uploaded source files matched the prepared release; the live graph, project profile and existing product routes returned successfully.

Review worker deployment: `dpl_C3HL7dHEY5NkXbh1oLpg4RhNvHHX`, with 37 exact source files verified. The API has 32 documented operations and 55 passing checks, including real PostgreSQL concurrency/recovery acceptance. These checks are not a claim of complete network delivery.
