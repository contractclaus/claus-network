# Original receipt reads (Native32 / API14)

Recovery of pending app writes uses app_request_receipt with the original principal, operation, idempotency key and canonical request hash. It reads only an existing immutable result and never resends a write. Current project write revocation does not hide the original principal's historical receipt. Invalid/revoked sessions cannot read it; absent or conflicting evidence stays unresolved. Existing parents, child admission, scope and concurrency rules remain.

# Original program runs (Native31)

Each new program is recorded as a private parent action before its first API step. Project and work admission are serialized; the durable parent blocks another program for either resource between steps and after a crash. An execution lock coalesces concurrent attempts to continue the same run. Child reservation and parent completion also lock the parent row, so a delayed process cannot append a step after termination.

`resume_network_operation` accepts the original run ID as well as an original step ID. A parent retains the exact request, permission mode and source hash. Completed steps are read from their original journal; pending steps retain the original API idempotency key. The existing cycle still reconciles at most two original API steps and does not automatically invent a replacement run. Failed observations are rotated fairly so one held operation does not indefinitely hide the others.

New action hashes use canonical JSON. Legacy step hashes are not rewritten: their immutable database input, fixed operation schema and original derived key remain authoritative. Changed code or withdrawn work authority stops a parent only when all original child effects are settled; unresolved children keep it held. A stopped parent does not reverse earlier successful writes.

No new table, source path, financial authority, scheduler or public API was added. Native30 was briefly promoted but was never pinned or handed to a new runner; Native31 adds the parent-row reservation fence before runtime adoption. Previous handoffs and original actions are retained.

# Isolated operating code

Native29 extends the existing editable `src/isolated/network.json`. In addition
to `analyze(input)`, a reviewed program may implement `operate(input)`. Its
JavaScript runs only in the existing QuickJS heap, without Node, credentials,
network functions, a database handle or a signer.

`run_network_program` requires an active original work item, its revision and an
authorized project. The fixed host passes a JSON request and original receipts
to the guest. The guest returns a proposed API operation or a result. The host
allows at most four operations and rechecks current work and operating authority
before each one. The project and original idempotency keys are host-bound.

Allowed writes are the existing idempotent app record create/update and app
configure/publish operations. Schema checks and current API authorization still
apply. This does not add signing, payments, paid reviews, account changes,
administration, arbitrary URLs or raw server-source permission. The editable
file list is unchanged. Broader server-source delegation is still incomplete.

The fixed action journal stores each original input, source hash and result.
An unknown write stops that program. The existing cycle reconciles at most two original program operations before continuing; it creates no replacement run. Pending program operations remain visible privately, and the affected project/work cannot start another program until its original outcome is resolved. Unrelated work can continue. `resume_network_operation` accepts only an
original operation from this feature, revalidates its binding and current work,
and uses the exact original API idempotency key. It never restarts a whole run.
All program outputs and action records remain private. Oversized successful
responses retain success and a content hash; they are not reported as failures.

The default program only reads its project. It makes no network write.
Existing analysis and work-order behavior remain. A successful local client
read through a hosted source snapshot is distinguished from actual autonomous
use by Claus. No autonomous use is claimed until a real receipt exists.
