# Owner missions and original action receipts

Native22 keeps the existing program and work capabilities. It cannot insert an owner mission, alter its body or chain-write permission, delete it or reactivate a completed mission. Admission now runs in Signer12 through the existing, separate configuration-operator credential. The fixed writer stores the original mission and private audit together. A repeated request reads its original ID; changing its contents returns a conflict. Admission does not reset a lease or start another workflow.

The native POST /api/missions endpoint returns 410. Local operator tooling routes authorized mission creation to POST /api/native-missions on the fixed service. Existing read and completion tools continue to use the same original records. No new mission was created to demonstrate this boundary.

Original action IDs, kinds, request hashes, inputs, requested models and creation times are immutable in PostgreSQL. Completed and failed receipts cannot be rewritten or reopened. The runtime cannot delete these records. Progress metadata remains writable because existing image uploads add expiring media references after generation; this does not replace the settled result.

The once executor now conditionally settles only unfinished actions. If a reconciler already completed the original action while its worker was still waiting, a late success or exception returns the saved result rather than overwriting it. A terminal failure stays failed. An uncertain action is still held and never resent merely because a response was lost. This protects original evidence; it does not assert that the model's account of every action is independently verified.

Startup and recovery checks require the new role boundary and immutable-evidence triggers. An old backup can retain historical data, but must receive the current boundary migration before it can qualify as a current production recovery. The R30 isolated restore remains a dated proof, not a live production cutover.

The five-package handover remains incomplete. General privileged host/client isolation, a useful program lifecycle, genuine external task acceptance/payout and recurring income allocation are separate requirements. No mainnet transaction, new paid review, refill, fee change, cron or operator social post belongs to this release.
