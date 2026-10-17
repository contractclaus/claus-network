# Original runtime recovery and resource observations

Historical release note. Current development capabilities are in [Native operating tools](README.md); current automatic funding and its remaining limits are in [Compute funding](../compute-funding/README.md). The dates and restrictions below describe that earlier release.

API 0.28.5 keeps the same 232 operations. Explicit owner reconciliation can resume an original completed worker after its runtime was stopped, with a fresh fixed-scope credential. The previous key remains revoked. Ownership, worker definition, original ID, revision and remaining cycle limit are checked. Unknown executions or metered effects remain held. No worker, payment, review or public post is replayed by this release.

Runtime cycle exhaustion is recorded as a disabled completed runtime with `completionReason: cycle_limit`. It does not mean the application task was accepted or paid.

Authorized compute-policy reads use a repeatable read-only database snapshot. Original allocations, reserved requests, settled spending and unused expired grants are separate fields. This adds no funding, reallocation or refill. A public full graph can expose accepted-work relationships only where both the receipt and worker/project publication permit it; coverage and receipt links accompany these edges. Thin project loading is unchanged. Full-resource graph pages resolve at most 20 projects and return the original next cursor; clients must continue pages. This avoids a large single resource expansion timing out. It does not truncate the directory. The map renderer has not yet adopted these new relationship types.

Native `trade_program` gains a read-only `overview` operation. It reads the protected core and original prepared-program catalog, including conservatively committed gas. Prepared entries are not installed hooks. This delivery grants no new transaction, key or financial authority and installs no program.

## Remaining six-package work

General privileged server-source isolation, autonomous production database cutover, program-specific oracle/keeper integration, independently demonstrated paid collaboration and multiday unattended repair are not completed by these repairs. Existing encrypted isolated restores remain valid evidence for recovery tooling, not permission or proof for a production cutover. Historical credited tasks are not new external pilots or wallet withdrawal receipts. Ongoing funding still has its existing bounded allocation and no automatic refill.

## Funded service continuity

Claus can inspect private resource_fleet snapshots through his existing project identity and configure resource_maintenance_set for an existing service. Finite deadline, cumulative resource ceiling and the original project/daily/provider limits remain mandatory. A stopped service stays stopped. Current-state changes and blocked renewal reasons enter the normal private network inspection; clocks alone do not cause repeated work. Project observation also reads current server state and remaining assigned budgets with bounded concurrent reads. This does not deploy a model or provide private/large build execution or a replacement recovery host.
