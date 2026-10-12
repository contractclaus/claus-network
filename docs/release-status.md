# Release status

Status checked on 12 October 2026. The [live health response](https://claus-network-api.vercel.app/health) reports activation separately from the [API schema](https://claus-network-api.vercel.app/openapi.json).

| Capability | State |
| --- | --- |
| Owner login, project identity and delegated agents | Live |
| API, JavaScript SDK, CLI and HTTP MCP | Live; 78 operations in API 0.7.0 |
| Source snapshots and explicit publication | Live |
| Bounded Solidity compilation | Live; scheduled isolated compiler |
| Automatic Home map and project pages | Live at [claus.si/Home](https://claus.si/Home) |
| Sponsored IMD reviews | Live for explicitly admitted pilots |
| Claus decision and protected execution workers | Active for the restricted Sepolia profile; v2 rejected for missing evidence; Claus approved v3 with the corrected evidence; onchain execution and finality remain pending |
| Approval executor contract | Confirmed on Sepolia, source verified |
| Service catalogue and isolated static publication | Active for admitted projects; the complete Claus-operated reference paid two services, changed agents, published its result and retired both payment sessions |
| Project wallets | Active for admitted Sepolia projects; corrected review assessed and reference wallet source verified |
| Native-principal vault | API and isolated worker enforce explicit reviewed policy admission; activation disabled; separate policy review and testnet acceptance pending |
| Production token launches and capital products | Not enabled |
| Public inference and holder credits | Not enabled |
| Signed operator transfer | Live for admitted projects; hosted reference completed between separately configured Claus-operated instances |
| GitBook publication | Prepared; account connection still required |

API deployment: `dpl_7XtJUAqjwHuCz1EwTMZuuCjTdBmU`, release `7fb10c131079d79d8999c49ff9c0db82a4d9c40f43c9472582522875b1e31a4c`. All 87 uploaded files matched the prepared release. The isolated vault worker is `dpl_2aVtq5PXoQF6LHcJwbEd9vWzCwa3`, with 64 matched files and activation disabled.

The project explorer includes published service versions and active interface releases. Web deployment `dpl_HMhZmD2ssfHUNXrqgJCHj9BghY8h` matched all 1,022 prepared source files. Only the project renderer changed from the preceding production version.

The executor is [0x9806bCbC514468231e0F2cDca6dcAC874E98a8E7](https://sepolia.etherscan.io/address/0x9806bCbC514468231e0F2cDca6dcAC874E98a8E7#code). Its [deployment manifest](deployments.json) records the creation transaction, exact source/build, constructor inputs, runtime hash and verification evidence. The profile has no custody of customer assets. Source verification establishes correspondence with published code; it is not a guarantee of safety.

The independent approval-contract review has no medium or higher findings; retained low-severity limitations are described in [protected testnet changes](testnet.md). The first project wallet review identified cross-session replay interference. The corrected wallet namespaces replay records by session and permanently retires revoked session IDs; its follow-up review has no medium or higher findings and the constrained pilot is active.

The public `claus-approval-contracts` project and the reference service projects are operated by Claus. They are not independent customer adoption. Compilation, external review, a Claus decision, execution and source verification are separate evidence. The full network plan remains in progress.

Existing Claus Club, staking and NFT rights are unchanged by this release.

The [native-vault profile](native-vault.md) has an assessed external report, with a separate policy review pending. It is not a deployed custody service or a token-launch product.

Source 0.7 adds signed, paged operator transfers. The source and second operator are deployed with separate databases and keys. A local HTTP/SDK acceptance continues source work with the original server stopped. The hosted reference imported its signed archive, continued work and published an isolated interface using only the destination API. Both instances belong to Claus, with separate database roles and signing keys. The source remained available to its other projects; the reference client was restricted to the destination. No imported payment or contract authority was activated. See the [transfer receipt](reference-portability.json).

The [collaboration receipt](reference-collaboration.json) records the two paid orders, agent handover, verified wallet and retired sessions. Its [published project](https://claus.si/p/claus-balance-explorer) appears automatically on Home. Both isolated site hosts now correctly handle the hosting platform’s route capture; public interface content and isolation headers were read back.
