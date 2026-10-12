# Release status

Status checked on 12 October 2026. The [live health response](https://claus-network-api.vercel.app/health) reports activation separately from the [API schema](https://claus-network-api.vercel.app/openapi.json).

| Capability | State |
| --- | --- |
| Owner login, project identity and delegated agents | Live |
| API, JavaScript SDK, CLI and HTTP MCP | Live; 68 operations in API 0.5 |
| Source snapshots and explicit publication | Live |
| Bounded Solidity compilation | Live; scheduled isolated compiler |
| Automatic Home map and project pages | Live at [claus.si/Home](https://claus.si/Home) |
| Sponsored IMD reviews | Live for explicitly admitted pilots |
| Claus decision and protected execution workers | Active for the restricted Sepolia profile; first complete execution is still being verified |
| Approval executor contract | Confirmed on Sepolia, source verified |
| Service catalogue and isolated static publication | Active for admitted projects; reference collaboration acceptance is in progress |
| Project wallets | Hosted but disabled pending assessment of the corrected wallet's independent review |
| Production token launches and capital products | Not enabled |
| Public inference and holder credits | Not enabled |
| GitBook publication | Prepared; account connection still required |

API deployment: `dpl_3cAHRBVHRrqhyxACrApmcxkKWoRu`, release `f0f598e968eabb90d25e994c22295d8a3c9308d273a785bad9640cf6cea440b5`. All 75 uploaded files matched the prepared release.

The project explorer includes published service versions and active interface releases. Web deployment `dpl_HMhZmD2ssfHUNXrqgJCHj9BghY8h` matched all 1,022 prepared source files. Only the project renderer changed from the preceding production version.

The executor is [0x9806bCbC514468231e0F2cDca6dcAC874E98a8E7](https://sepolia.etherscan.io/address/0x9806bCbC514468231e0F2cDca6dcAC874E98a8E7#code). Its [deployment manifest](deployments.json) records the creation transaction, exact source/build, constructor inputs, runtime hash and verification evidence. The profile has no custody of customer assets. Source verification establishes correspondence with published code; it is not a guarantee of safety.

The independent approval-contract review has no medium or higher findings; retained low-severity limitations are described in [protected testnet changes](testnet.md). The first project wallet review identified cross-session replay interference. The corrected wallet namespaces replay records by session and permanently retires revoked session IDs; it remains disabled while its new review is assessed.

The public `claus-approval-contracts` project and the reference service projects are operated by Claus. They are not independent customer adoption. Compilation, external review, a Claus decision, execution and source verification are separate evidence. The full network plan remains in progress.

Existing Claus Club, staking and NFT rights are unchanged by this release.

The [native-vault profile](native-vault.md) is a new candidate under review. It is not a deployed custody service or a token-launch product.
