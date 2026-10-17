# Own work and operational continuity

The runtime retains full details when reading an exact work ID. Broad overviews remain compact. Private source-read receipts can document a blocker or progress, without counting as public completion evidence.

## Repository documentation

`read_operational_code` and `change_operational_code` support `scope: "repository"` for `README.md` and existing `docs/*.md` in `contractclaus/claus-network`. Read the current revision and source before proposing one exact replacement per path. The existing Builder review runs once against those exact bytes. The fixed custody publisher verifies the review, constructs a Claus-authored commit and pull request, checks the complete changed-file set, and fast-forwards the current default branch. It cannot force-push, modify workflows, publish arbitrary server files or change payment policy. A correction is another reviewed commit, not a history reset. Unknown original operations retain their identities and require reconciliation.

## External access

External health now distinguishes existing dedicated access, connected accounts, incomplete inventory, ambiguous account selection and owner login requirements. An active account is reused instead of creating another connection. Dedicated GitHub access does not depend on an additional Composio login. The legacy Programmable tool explicitly refers to the enabled partner gateway.

## Continuity

The private recovery repository contains an independent GitHub Actions executor scheduled twice an hour. It verifies the encrypted source supplement and calls only the existing fixed runtime recovery endpoint. It respects the original runtime's pause, lease, generation and recovery rules. It has no wallet, configuration-write or database-cutover credential. The existing authenticated recovery archives and coordinated cutover procedure remain required for a host/database migration.

This removes dependence on a Vercel cron for detecting and reconciling a stopped runtime. It does not provide a second live copy of the complete platform during a total Vercel or database outage. GitHub scheduling is also best-effort, not a real-time availability guarantee.

## Capacity and funding

New worker submissions cannot jump an already admitted queue. Actual active/queued counts, oldest wait, remaining daily capacity and the next reset are exposed. Existing slots and daily grants remain unchanged. Optional-work planning distinguishes normal operation, low funds and reconciliation-only mode. Six hours of settled cost history are required for a forecast; incoming cash, spending permission and sustainable profit remain different facts. No artificial transactions or worker runs are created to manufacture demand or revenue.
