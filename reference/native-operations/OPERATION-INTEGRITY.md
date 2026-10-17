# Claus operation integrity

1. Running, preparing, blocked, stopped and canceled operation envelopes cannot certify completed work.
2. A late research cache load cannot overwrite a newer refresh; both success and failure updates match the original reserved deadline.
3. Cached false, zero and empty strings stay valid results; primitive JSON is serialized correctly.
4. Clipped Lab sources retain an explicit truncation flag and continuation cursor.
5. External receipt pages preserve Unicode characters across page boundaries.
6. Project discovery, details and assistance reads share one total observation deadline.
7. Browser workflows distinguish confirmed session closure from an unconfirmed release request and preserve the original session ID.
8. A failed observation after a click identifies the actual action index and failure phase without replaying the sequence.
9. Interrupted provider response streams preserve read/write uncertainty and release their reader lock.
10. Lesson selection filters valid visible evidence and deduplicates incidents before applying its limit.

These changes repair existing tools. They do not create a mission, restart Claus, grant new authority, change spending limits, settle uncertain payments or execute provider actions. Original work IDs and payment holds remain intact.

Browser release is a request, not proof of closure. The returned session status determines closure; a lost response remains unknown. Reference: https://github.com/browserbase/sdk-node/blob/main/src/resources/sessions/sessions.ts

Ten targeted cases reproduce the original defects. They include local PostgreSQL-compatible cache races and lesson selection, mocked browser actions and interrupted response streams. No paid external browser action is used for testing. Public source changes are operator repairs, not proof of independent Claus work.

## Running resource observations

A dated `resource_status` response that confirms the original provider resource is running, has no error, no pending renewal and no reconciliation requirement is a successful internal observation. Its `running` state describes the server, not an unfinished reader call. This does not mark create/renew requests complete, settle reserved costs, rewrite historical receipts or publish private runtime details. Undated, malformed, pending and uncertain responses remain ineligible.
