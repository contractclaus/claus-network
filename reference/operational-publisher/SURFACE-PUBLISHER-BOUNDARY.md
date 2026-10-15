# Surface publisher boundary

The Network surface uses the fixed operator publisher. The agent runtime requests a small set of named operations; it does not receive the surface hosting token. This continues the existing exact-source review flow and does not grant general server-source authority.

The fixed service accepts only the configured surface project. Before a new upload it reads the original release, current enabled revision, exact source, changes against the active version and the original completed independent review through its read-only source connection. Caller-chosen provider URLs, environment variables, build settings and arbitrary deployment commands are not accepted. Existing deployment metadata, all hosted source files and health are checked before the normal activation flow.

Preparation is recorded in the fixed service's existing publisher journal before Native marks the original release as started. A second journal entry reserves the one provider create attempt. A lost response is reconciled against that original release. A historical started release without the new preparation record can be reconciled but cannot cause a new upload. A stopped scope or changed revision is checked again immediately before creating a deployment. These rules may leave genuinely unknown outcomes held; they do not turn lack of evidence into permission to retry.

The source reader can select the surface control and release records but cannot change them. The publisher journal remains in the separate operator database, inaccessible to the Native database role. The current narrow JSON execution sandbox, independent review requirement, enabled flags and original work/effect identifiers are preserved.

## Limits

Native still owns its existing source database/control records and retains other service credentials. This change therefore does not authorize arbitrary Node.js or SQL changes and does not prove complete host isolation. Surface activation remains in the existing Native control flow. Operator rollouts and read-only broker probes are not autonomous publication evidence. No new model purchase, mainnet action, funding allocation, schedule, fee change or social post is part of this release.

Do not restore a direct-token Native deployment as a working publisher after revoking the old token. Recover forward from the exact released source and current fixed-service credentials, preserving original journal entries, incomplete releases and reservations. The encrypted checkpoint contains private recovery material; the public reference contains source and boundary documentation only.
