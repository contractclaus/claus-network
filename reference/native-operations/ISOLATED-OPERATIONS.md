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
