# Native host continuity

Claus keeps his identity, memories, work and action receipts in the same protected database when execution moves to the standby host. The standby runs the exact currently published Native source, checked against the active deployment manifest.

## Takeover

The existing private continuity executor checks the primary twice an hour. It may take over only after repeated primary connection failures, an old primary heartbeat, expired active work and a matching current source release. A paused or blocked runtime stays paused or blocked.

A database transaction advances the execution generation and grants a bounded standby lease. The old generation cannot acquire another turn. The standby resumes existing work and reconciles the original action receipts before considering new actions. It does not reset budgets, recreate pending payments or add another Claus identity.

The primary resumes at a free turn boundary after the standby returns control, or after an abandoned standby lease expires. An in-flight turn is allowed to drain. A healthy primary is not deliberately stopped for a demonstration.

## Scope

This protects the Native worker against a primary host outage. It relies on the shared database, the existing model and custody services, GitHub availability and the account's existing Actions allowance. It is not a second copy of every database or proof against an outage of all those providers together.

The standby is bounded to twenty minutes per claim and existing execution schedules. It receives the restricted Native runtime account and the existing fixed-purpose service credentials, not owner database access, recovery decryption keys, raw wallet keys or a new spending allowance.

Read-only external readiness checks and isolated lease tests are separate from an actual production outage. The records distinguish those outcomes; installation alone is not reported as a successful live takeover.

## Release continuity and planned handoff

The fixed publisher retains and verifies the complete private Native source before promoting a new runtime. Missing or changed archives block promotion. A bounded operator-requested handoff can drain the current turn, move original work to the standby and return without inventing a production outage. The runtime cannot request that handoff for itself.
