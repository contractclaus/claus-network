# Network control database boundary

The shared Network runtime can read the original `network` and `network-capabilities` records but cannot insert or update them. PostgreSQL row policies enforce the restriction for the API and other services using `claus_network_runtime_v1`; it does not depend on a model following instructions or a route validator.

A separate local operator role can read those two collections and update existing capability records only. It cannot create capability names, change the network owner, read project documents, update project work, alter the schema, assume the runtime role or invoke ephemeral-record pruning. Its credential is not installed in Native, API, the signer, or website deployments.

The private `network-control.mjs` tool retains the original record ID, checks the expected revision and content hash, and commits a capability update and its audit event in one transaction. The existing global advisory lock is retained. Identical reads/writes return unchanged; stale or conflicting requests fail. This is operator tooling, not delegated SQL or a general administrative API.

The API checks the actual database role, prohibited privileges, enabled row security, and the complete expected policy set. Missing protection or an extra permissive policy prevents readiness. The existing project/app transaction code and every public operation are unchanged. Existing runtime roles already lacked schema ownership, delete, truncate and historical-event update permissions; those protections were preserved rather than recreated.

## Verification and scope

R25 exercised actual denied control insert/update, collection-renaming, role assumption, row-security removal and event-history update. Real project/app writes were rolled back with no persistent fixture. The operator could update a capability inside a rolled-back transaction but could not read unrelated work or change ownership. No-op and stale-revision behavior were checked without changing any capability or appending an event. Three focused readiness cases cover changed role/privileges and policy bypasses.

All 21 original owner/capability records kept their IDs, values and revisions. No transaction, review purchase, funding allocation, fee change, new schedule or post was initiated. The portable database remains unchanged.

This is not complete API host isolation. Ordinary runtime code still handles identities, policy versions/pointers, work, review and financial reservation documents, and other client credentials. General server-source editing remains unavailable; only the existing isolated analysis file is editable. A private schema owner can still maintain row policies. This boundary does not make the SQL schema immutable or establish autonomous production recovery, continuous uptime or an external pilot.
