# Managed contracts

The managed profile is admitted on Ethereum and Sepolia within separately funded gas and review limits. [Deployment and lifecycle evidence](reference-managed.json) records exact source verification and the [Claus-operated reference](https://claus.si/p/managed-contract-reference). Check [live capabilities](https://claus-network-api.vercel.app/v1/public/capabilities) before submitting work. Existing readonly contracts keep their original execution model and permissions.

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

Managed registrations wait for chain finality on both supported chains before becoming ready for a proposal. A mined transaction can therefore remain `registering` until its evidence is finalized.

The network accepts owner-selected upgrade delays from zero through five days. The underlying registry also permits longer delays through direct owner calls, but a delay above five days permanently removes that instance from the network's supported upgrade workflow: the registry never allows an accepted delay to decrease. Do not increase it beyond five days when using the network API.

The demonstrated Counter workflow activates with the nonempty `initializeCounter(7)` configuration committed at registration, then upgrades to CounterV2 with empty data. Behind the reviewed managed proxy, the initializer accepts only the registry and rejects a second initialization after its flag is set. The registry does not itself require nonempty first activation: omitting it would leave initialization available during a later approved upgrade and could reset accumulated count. Values near the uint256 ceiling can also make increments revert. These are known reference boundaries; they are not prevented by the generic registry. The same authorization claim does not extend to arbitrary hosting proxies.

## Boundaries

The registry also rejects its own managed project proxies as implementations, preventing one project from silently following another project’s upgrades.

Use the target address returned by a verified registration. Registrations use the registry's creation nonce, so a predicted address can change if another registration executes first. Never fund or advertise an unconfirmed target.

Each chain/profile has a separate admission policy, exact executor and target-artifact pins, assessed review evidence and gas allocation. A readonly admission cannot enable managed contracts or pay their gas. No profile is activated merely by publishing its source.

The immutable registry and fixed proxy selectors cannot be replaced by project storage writes. Direct module `DELEGATECALL`, `CALLCODE` and `SELFDESTRUCT` are excluded from this initial profile. Project code may change its own state and call declared external contracts; review must assess those effects and any storage migration. A review cannot guarantee that code is harmless.

The onchain code hash binds the immediate implementation, not every external behavior it can invoke. Admission checks and review must reject hidden or mutable external logic that bypasses the reviewed change path. Declared dependencies and intentional mutable data remain part of each proposal's evidence.

Financial products, customer custody, token launches and public inference are outside this profile. Existing signal stores and vault references are not automatically attached to managed projects. The released profile has independent review, exact-source deployment, explicit admission and a completed activation, state-preserving upgrade, onchain callback and revocation reference. These establish the demonstrated workflow, not the safety of arbitrary modules.

With a zero upgrade delay, revocation has no guaranteed intervention window and cannot undo an executed change. The owner may opt into a delay when registering. The immutable recovery owner can pause new approvals and replace the Claus signer after the fixed recovery delay. These are explicit trusted powers.

Revoking upgrade authority does not stop calls to the currently installed module. Any application pause must be part of the separately reviewed module; the registry is not an emergency pause for application execution. Cancelling signer recovery also invalidates outstanding Claus approvals through its generation counter, even if no recovery was pending.

The proxy's registry lookup and delegation exceed the 2,300-gas stipend used by Solidity `transfer` and `send`. They must not be treated as supported payment paths. This release does not admit payment or custody applications.

The current hosts reuse one Claus approval key and one transaction payer per chain across readonly and managed profiles. Typed domains, admissions and accounting remain separate; this is not separate key custody for the two profiles. Disabled profiles do not prevent other profiles from running.

Send an explicit chain and profile with every managed review request. If the chain is omitted, the current API resolves the existing project chain, or Sepolia for an unbound project. The response exposes this resolved chain before acceptance; check it before accepting a sponsored review. Module deployment and approval consume only matching review evidence. Historical readonly reviews without a selected chain remain chain-neutral. An existing paid review cannot be relabelled by changing the request scope.

A reverted execution does not cancel its onchain approval. Until expiry or nonce cancellation, a relayer can submit those same approved bytes again. The owner can call the registry's `cancelApproval(projectId, nonce)` or revoke project authority; an API failure status alone is not onchain cancellation.

The integrated deployment path excludes delegated EOA implementations and requires a network-deployed verified module. The registry's code-hash check alone does not enforce every API admission rule.

## Source verification

Managed modules are compiled without appended CBOR metadata. Sourcify can label these as `match` even when the entire creation and runtime bytecode agree. For this compile profile, the network additionally requires identical complete onchain and recompiled bytecode, exact pinned source and compiler input (excluding output selection), the expected compiler and contract name, matching chain/address/deployment transaction, no bytecode transformations or immutables, and an Etherscan source listing. The stored evidence preserves Sourcify’s original label and explicitly records that no onchain metadata fingerprint was verified. Source comments and formatting are bound by the published snapshot, not by an absent onchain metadata hash. Other compile profiles retain the exact-match requirement.

## Operating limits

The native review input has a 900,000-byte canonical JSON limit. It includes the current source and compiler artifact, the previous source and compiler artifact for an upgrade, and the independent report. A successful compile or first activation does not guarantee a later proposal fits. Keep source and reports compact and account for both versions before deployment; oversized proposals fail with `review_context_too_large` before an approval is requested. The network does not shorten review evidence to fit.

Ethereum and managed Sepolia upgrade queue transactions can advance after three canonical block confirmations. Their complete gas reservation remains held until finality; changed queue receipts block fresh execution. Actual upgrades, source-backed deployments and registrations retain finality before being reported complete. Transactions still share a chain payer, so those finality-bound operations can delay other work on that payer. A failed or withdrawn queue may leave its gas reserved for reconciliation.

The active profiles must match the shared host signer and payer. Enabling a profile with different keys stops that host’s chain worker until configuration is corrected; dedicated per-profile keys are not supported by this release. The release procedure checks matching keys before admission.
