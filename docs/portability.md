# Portability

Source 0.7 includes signed, paged operator transfers. Local tests exercise the complete HTTP/SDK path with separate stores, stop the source server, and continue work on the destination. The live hosted transfer is not yet accepted. Check [release status](release-status.md).

`project_transfer_prepare` is an explicit one-way move, available only to the project owner for an admitted project. In one transaction it fences new source work and creates an operator-signed archive. Repeating the request returns that exact archive. If capture fails, the transaction rolls back the fence. Source reads, key revocation, exits and completion of already paid services remain possible. Existing onchain signatures and completed transactions cannot be undone by an API fence.

Download the pages with `project_transfer_page`. On the destination, authenticate the same owner and call `project_import_begin`, upload every page with `project_import_page`, then call `project_import_commit`. The destination pins trusted operator keys in its own configuration and checks the owner, destination, signature, every page hash and source-file bindings. Interrupted uploads resume under the same archive ID. A second commit returns the existing result; it cannot overwrite another project.

The project keeps its ID and all source versions. New local credentials and mandates authorize further work. Historical reviews, costs, deployments, service results and pending external request IDs remain available through `project_import_history`. They retain their source operator's attribution. Imported jobs, balances, publications, wallets and contract permissions are not activated automatically. A pending external effect stays with its original payer and request ID for reconciliation.

The initial transfer admission is bounded to 2,000 records and a 3.5 MB archive, with pages below 200 KB. This limit is checked before the source fence commits. The source retains its signed archive for recovery. A fenced source project cannot start a second outgoing move; moving back requires a separately implemented return protocol. This release does not advertise reversible migration.

The older `project_export` operation still exports one source snapshot. It neither freezes nor migrates a project.

## Archive and provenance

A full archive must contain project identity, all selected source versions, build and review evidence, deployment bindings, service manifests and results, published interfaces, cost receipts, pending operation identities and the project's event history. It must explicitly state which resources were omitted. Credentials, private keys, provider secrets, live leases and reusable signed payment material must never be included.

The archive needs a consistent source revision, canonical content hashes and a signed manifest. A destination must verify the source operator's signing identity against its configured trust set; an arbitrary public key inside an archive is not a trust anchor. Historical verification keys must remain available after rotation. Owner authentication must match the attested project owner before the destination preserves the original project ID. Otherwise someone could claim another project's ID simply by editing an exported JSON file.

Imported history remains attributed to its issuing operator. A destination must not turn an owner-supplied claim into an independently verified audit, successful payment or completed deployment. Chain evidence must be checked against the stated chain, contract, transaction and finality policy.

## Work handover

The destination issues fresh local credentials and mandates. Existing source credentials do not gain authority on the destination. The source must fence new work before the destination continues project work, and the destination must acknowledge the exact handover revision. The initial transfer preserves pending operations as history, with reconciliation remaining at the source. A failed handover resumes from that revision rather than creating new jobs.

Pending external effects retain their original provider request ID, payment identity and payer. An unknown paid request is reconciled, not re-purchased. Cancellation is only final when the relevant provider or transaction path proves the effect was not sent. If a provider cannot transfer or reconcile a live job, the archive must expose that limitation and keep the job with its original operator.

An imported cost record is history, never a new funded balance. Funds remain in their original wallet or provider account until the owner explicitly authorizes a supported transfer. Contract ownership and session keys are independently verified; importing a database row does not rotate onchain authority.

Claus-controlled upgrade contracts retain their disclosed dependence on Claus. Ordinary source work, service use and interface publication may continue on a compatible operator, but that does not give the destination a Claus approval key.

## Acceptance still required

Hosted acceptance still requires a second separately configured operator to import a genuine archive, authenticate its owner and continue permitted work while the first operator's website and coordinator are unavailable. Tests must cover a forged archive, altered owner, reused project ID, revoked authority, interrupted handover, pending paid work and a second import of the same archive. Neither a local file export nor two clients of the same database satisfies this requirement.
