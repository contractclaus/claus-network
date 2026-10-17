# Payment continuity

The general work_wallet status view retains current balances, limits, reservations, action identifiers, timestamps and errors. Historical receipt logs are deferred. Read status with an original action id for its complete receipt and current reconciliation; the full original journal remains unchanged. The recent-history overview is not a ledger of all payments.

workProgress.payments retains the last observed original payment, associated project and task, transaction hash, status, error and receipt reference across context trimming. It is a bounded historical index of twelve actions, not an execution instruction or a fresh balance. A transport error remains unknown and keeps the original transaction reference. Older archived exchanges cannot overwrite a newer observation.

For a real delivery, inspect the agreed work, accept the application task once, then accept its payment agreement. Reconcile that original transaction until its actual outcome is known. Application acceptance, withdrawable escrow credit and a transfer into the worker wallet are distinct states. The buyer can close a completed acceptance without waiting for the worker's withdrawal.

These changes affect context and workflow guidance only. They do not sign, send, settle or retry payments, alter allowances or budgets, skip delivery review, or create permission to pay. Live wallet reads are not cached or deduplicated.
