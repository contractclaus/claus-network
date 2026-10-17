# Infrastructure observations

The existing operating observation reads the original resource fleet and the assigned profiles for its active projects. It keeps project IDs and pagination. At most ten active projects are inspected per fleet page; profile reads are parallel, deduplicated and read-only. No provider purchase, replacement resource, grant or renewal is made by this observation.

Funding is joined by both project and profile. Failed, missing or contradictory observations remain unavailable, rather than becoming zero or borrowing another project's allowance. Closed resources do not raise live-service expiry alarms. Active resources expose expired grants, blocked or expired maintenance, exhausted renewal ceilings and an expired provider-confirmed lease. A configured policy is not proof of an actual renewal. The attention signature omits changing clock values and ordinary balance drift.

The JavaScript client preserves unknown mutation outcomes, including the API's HTTP409 reconciliation response. It never automatically repeats a write. The agent client ignores obsolete login results after clearSession and does not let a late401 discard a newer session. clearSession clears the local session; it is not server-side credential revocation and cannot undo requests already sent.

These changes were checked with focused local cases and an authenticated read of the original running resource and assigned grant. They do not certify every wallet, create a new model endpoint or claim indefinite autonomous operation.
