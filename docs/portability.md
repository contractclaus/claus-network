# Portability implementation boundary

The current export contains one source snapshot. It is not yet a full migration to another network operator. Switching agents within the same project is a separate capability and does not prove operator independence.

The source candidate now includes a separately tested archive codec in `src/portability/index.mjs`. It captures source versions, project artifacts, review and deployment history, service records, payment identifiers and project events under one consistent database transaction. An Ed25519 signature binds its manifest and content pages to an operator key configured by the recipient. Runtime credentials, reusable signatures and other projects' records are excluded. Four targeted checks cover content tampering, owner and key mismatches, revoked export rights and retained verification keys after rotation.

This codec is not exposed by the deployed API. Its output is explicitly `snapshot-only` and `historical-only`: it cannot activate imported spending authority or restart pending work. The fenced transfer, destination import and second-operator acceptance below remain required.

## Archive and provenance

A full archive must contain project identity, all selected source versions, build and review evidence, deployment bindings, service manifests and results, published interfaces, cost receipts, pending operation identities and the project's event history. It must explicitly state which resources were omitted. Credentials, private keys, provider secrets, live leases and reusable signed payment material must never be included.

The archive needs a consistent source revision, canonical content hashes and a signed manifest. A destination must verify the source operator's signing identity against its configured trust set; an arbitrary public key inside an archive is not a trust anchor. Historical verification keys must remain available after rotation. Owner authentication must match the attested project owner before the destination preserves the original project ID. Otherwise someone could claim another project's ID simply by editing an exported JSON file.

Imported history remains attributed to its issuing operator. A destination must not turn an owner-supplied claim into an independently verified audit, successful payment or completed deployment. Chain evidence must be checked against the stated chain, contract, transaction and finality policy.

## Work handover

The destination issues fresh local credentials and mandates. Existing source credentials do not gain authority on the destination. The source must fence new work before the destination adopts pending operations, and the destination must acknowledge the exact handover revision. A failed handover resumes from that revision rather than creating new jobs.

Pending external effects retain their original provider request ID, payment identity and payer. An unknown paid request is reconciled, not re-purchased. Cancellation is only final when the relevant provider or transaction path proves the effect was not sent. If a provider cannot transfer or reconcile a live job, the archive must expose that limitation and keep the job with its original operator.

An imported cost record is history, never a new funded balance. Funds remain in their original wallet or provider account until the owner explicitly authorizes a supported transfer. Contract ownership and session keys are independently verified; importing a database row does not rotate onchain authority.

Claus-controlled upgrade contracts retain their disclosed dependence on Claus. Ordinary source work, service use and interface publication may continue on a compatible operator, but that does not give the destination a Claus approval key.

## Acceptance still required

A second separately configured operator must import a genuine archive, authenticate its owner and continue permitted work while the first operator's website and coordinator are unavailable. Tests must cover a forged archive, altered owner, reused project ID, revoked authority, interrupted handover, pending paid work and a second import of the same archive. Neither a local file export nor two clients of the same database satisfies this requirement.
