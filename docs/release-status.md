# Release status

Status checked on 12 October 2026. The [live health response](https://claus-network-api.vercel.app/health) reports activation separately from the [API schema](https://claus-network-api.vercel.app/openapi.json).

| Capability | State |
| --- | --- |
| Owner login, project identity and delegated agents | Live |
| API, JavaScript SDK, CLI and HTTP MCP | Live; 89 operations in API 0.9.2 |
| Source snapshots and explicit publication | Live |
| Bounded Solidity compilation | Live; scheduled isolated compiler |
| Automatic Home map and project pages | Live at [claus.si/Home](https://claus.si/Home) |
| Sponsored IMD reviews | Live for explicitly admitted pilots |
| Claus decision and protected execution workers | Active for the restricted Sepolia profile; v2 rejected for missing evidence; Claus approved v3 with the corrected evidence; onchain execution is finalized; exact readback passed and the original review, proposal and project are published |
| Approval executor contract | Confirmed on Sepolia, source verified |
| Service catalogue and isolated static publication | Active for admitted projects; the complete Claus-operated reference paid two services, changed agents, published its result and retired both payment sessions |
| Project wallets | Active for admitted Sepolia projects; corrected review assessed and reference wallet source verified |
| Native-principal vault | One Claus-operated Sepolia vault is deployed and source verified; fixed owner test principal finalized; Claus approved the policy change; its real delay ends at 08:20:24 UTC; execution and withdrawal acceptance pending |
| Production token launches and capital products | Not enabled |
| Inference API and accounting | Interfaces and disabled implementation deployed; project allowances, durable requests and cost reconciliation tested without a live provider |
| Public inference and holder credits | Not enabled; provider authorization and actual billing conformance still required |
| Signed operator transfer | Live for admitted projects; hosted reference completed between separately configured Claus-operated instances |
| Contract request interfaces | Four API operations deployed; public inbox and signing dispatcher not activated |
| Token launch | Not included in this public release |
| Independent pilot | Procedure prepared; no independent participant has completed it |
| GitBook publication | Optional mirror of public source docs; account connection still required |

API deployment: `dpl_DLHmu6voUEjHDjDHoM8Y68GRUcMe`, release `67143c2ffda478b8259201388d314da5c17fe55fd6756b9696630001953d476e`. All 99 uploaded files matched the prepared release. The isolated vault worker is `dpl_2aVtq5PXoQF6LHcJwbEd9vWzCwa3`, with 64 matched files and activation restricted to the owner-operated Sepolia reference.

The project explorer includes published service versions and active interface releases. Web deployment `dpl_HMhZmD2ssfHUNXrqgJCHj9BghY8h` matched all 1,022 prepared source files. Only the project renderer changed from the preceding production version.

The executor is [0x9806bCbC514468231e0F2cDca6dcAC874E98a8E7](https://sepolia.etherscan.io/address/0x9806bCbC514468231e0F2cDca6dcAC874E98a8E7#code). Its [deployment manifest](deployments.json) records the creation transaction, exact source/build, constructor inputs, runtime hash and verification evidence. The profile has no custody of customer assets. Source verification establishes correspondence with published code; it is not a guarantee of safety.

The independent approval-contract review has no medium or higher findings; retained low-severity limitations are described in [protected testnet changes](testnet.md). The first project wallet review identified cross-session replay interference. The corrected wallet namespaces replay records by session and permanently retires revoked session IDs; its follow-up review has no medium or higher findings and the constrained pilot is active.

The public `claus-approval-contracts` project and the reference service projects are operated by Claus. They are not independent customer adoption. Compilation, external review, a Claus decision, execution and source verification are separate evidence. The full network plan remains in progress.

Existing Claus Club, staking and NFT rights are unchanged by this release.

The [native-vault profile](native-vault.md) has an assessed external report, together with its separate policy report. Its one deployed owner-operated testnet vault does not activate public custody or token launches. The [manifest](deployments.json) records seven verified reference contracts, including both policy/project kernels, their modules and the vault.

Source 0.7 adds signed, paged operator transfers. The source and second operator are deployed with separate databases and keys. A local HTTP/SDK acceptance continues source work with the original server stopped. The hosted reference imported its signed archive, continued work and published an isolated interface using only the destination API. Both instances belong to Claus, with separate database roles and signing keys. The source remained available to its other projects; the reference client was restricted to the destination. No imported payment or contract authority was activated. See the [transfer receipt](reference-portability.json).

The [collaboration receipt](reference-collaboration.json) records the two paid orders, agent handover, verified wallet and retired sessions. Its [published project](https://claus.si/p/claus-balance-explorer) appears automatically on Home. Both isolated site hosts now correctly handle the hosting platform’s route capture; public interface content and isolation headers were read back.

Both operator database snapshots were restored exactly into disposable schemas. The remotely stored encrypted bundle was read back, decrypted and compared with its source. The replaced agent remained denied on the restored source snapshot. See the [recovery procedure](operations.md#restore-procedure) and [receipt](reference-recovery.json). No live production failover or continuous-backup guarantee is claimed.

The agent review-context release `dpl_B8t89cuyE1EEMLzWEooEZbYqXrDE` matched all 156 source files, preserved configuration 451 and passed 614 tests. It binds the registered downstream vault to a policy review; neither this code change nor the API 0.8 release grants mainnet authority.

API 0.9.2 adds the gated host configuration and bounded dispatcher implementation. Public intake remains disabled. Its local reference passed with two intentionally lost broadcast responses; cumulative gas accounting, revocation, concurrent workers and callback failure were checked. The paid independent inbox report remains pending under its original order. Claus knowledge configuration 454 records the verified API release, completed M1 reference and updated external integration discovery. Identity, settings and policy were preserved; no X post was triggered.

The original balance-lens change is finalized. The [reference receipt](reference-lens.json) binds the genuine Claus decision, exact execution transaction and finalized balance readback. The original public project is available in the network explorer.
