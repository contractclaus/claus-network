# Managed contracts: release candidate

The managed profile is implemented in this source candidate but is **not admitted on the live network**. Check the live discovery response before using it. Existing readonly contracts keep their original execution model and permissions.

`claus-managed-v1` supports reviewed stateful project logic behind an immutable registry. Registration creates a dormant project. The owner signs the first implementation and initialization commitment; Claus must separately approve the exact activation. Later upgrades use the same independent-review, Claus-decision and execution workflow. A project cannot switch between readonly and managed profiles after its first module deployment.

## Programmatic lifecycle

1. Create a project and a scoped agent credential using the existing API, SDK, CLI or MCP adapter.
2. Submit a Solidity snapshot with `build_create`, selecting `compilerProfile: "solidity-managed-compile-v1"`. This profile uses Solidity 0.8.27 and omits the appended CBOR metadata section. The full compiler input, metadata artifact and source remain available for verification; no bytecode is omitted from inspection.
3. Publish the source. Request `review_create` with `profile: "claus-managed-v1"` and the intended `chainId`; accept the quote through the existing bounded sponsorship flow. Retain its original job ID while it runs.
4. After review, call `module_deploy` with the same profile and chain. This fixes the project's profile. Wait for deployment and source verification.
5. Use `registration_prepare`, sign its exact typed owner commitment locally, and call `registration_submit`. A verified registration is still dormant: version zero, no executable project implementation.
6. Call `proposal_create` for the initial reviewed module and the exact committed initialization bytes. Claus assesses the source, independent report, finalized chain evidence, initialization and authority. Only an approval can activate version one.
7. To upgrade, compile and independently review the next module, deploy it and create a new proposal. The review now includes the previous complete source, compiler artifact, storage layout and current configuration. Successful execution installs the new version and performs its initialization atomically.
8. Revoke the API mandate and onchain project authority through the existing owner controls when needed. Revocation does not erase prior charges, transaction receipts or uncertain operations.

Registrations and module deployments use the existing API operations. MCP, SDK and CLI use the same operation schema. The website is optional.

## Boundaries

The registry also rejects its own managed project proxies as implementations, preventing one project from silently following another project’s upgrades.

Use the target address returned by a verified registration. Registrations use the registry's creation nonce, so a predicted address can change if another registration executes first. Never fund or advertise an unconfirmed target.

Each chain/profile has a separate admission policy, exact executor and target-artifact pins, assessed review evidence and gas allocation. A readonly admission cannot enable managed contracts or pay their gas. No profile is activated merely by publishing its source.

The immutable registry and fixed proxy selectors cannot be replaced by project storage writes. Direct module `DELEGATECALL`, `CALLCODE` and `SELFDESTRUCT` are excluded from this initial profile. Project code may change its own state and call declared external contracts; review must assess those effects and any storage migration. A review cannot guarantee that code is harmless.

The onchain code hash binds the immediate implementation, not every external behavior it can invoke. Admission checks and review must reject hidden or mutable external logic that bypasses the reviewed change path. Declared dependencies and intentional mutable data remain part of each proposal's evidence.

Financial products, customer custody, token launches and public inference are outside this profile. Existing signal stores and vault references are not automatically attached to managed projects. The current candidate requires its own independent review, exact-source deployment, real activation/upgrade/revocation reference and explicit admission before it can be described as live.

With a zero upgrade delay, revocation has no guaranteed intervention window and cannot undo an executed change. The owner may opt into a delay when registering. The immutable recovery owner can pause new approvals and replace the Claus signer after the fixed recovery delay. These are explicit trusted powers.

Revoking upgrade authority does not stop calls to the currently installed module. Any application pause must be part of the separately reviewed module; the registry is not an emergency pause for application execution. Cancelling signer recovery also invalidates outstanding Claus approvals through its generation counter, even if no recovery was pending.

The proxy's registry lookup and delegation exceed the 2,300-gas stipend used by Solidity `transfer` and `send`. They must not be treated as supported payment paths. This release does not admit payment or custody applications.
