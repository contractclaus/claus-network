# Payer review evidence reference

This source subset records the independent request binding and read-only evidence endpoint used by the fixed publisher. It is not a standalone deployment. Dependencies and the original payment/settlement implementation remain part of the full payer service. No new payment or review is created by an evidence read. See [review evidence boundary](../operational-publisher/REVIEW-EVIDENCE-BOUNDARY.md).

[Operating resources](OPERATING-RESOURCES.md) distinguishes private payer cash, provider credit, unresolved cost and the finite request allowance without authorizing transfers.

[Recovery and operating capacity](RELIABLE-RECOVERY.md) describes original receipt reconciliation, bounded buyback recovery and separate resource accounting.


Payment history lookup brackets the original authorization time from the safe head before binary search. Recent receipts no longer require genesis-era blocks from pruned RPC providers. The original signed authorization, matched settlement call, token transfer and canonical receipt checks remain mandatory; a missing receipt keeps the reservation. The existing authorized RPC account supplies historical receipt reads.
