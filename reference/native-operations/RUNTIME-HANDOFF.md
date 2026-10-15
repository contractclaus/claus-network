# Preserved-turn runtime handoff

The runtime upgrade no longer depends on catching a brief idle window. The next-turn generation is fenced atomically while the current lease holder retains its lease, continuation, memory, next wake time and original effects. The replacement workflow waits for that lease to release before it can execute. Old workflows cannot acquire another turn. A pause or blocked reconciliation state is not resumed by this change.

Owner requests use the existing authenticated upgrade endpoint with a stable request ID and exact production deployment. The existing handoff ledger retains the request hash, dispatch outcome and eventual observed turn. A repeated or uncertain request never dispatches another workflow. An actual matching new lease holder records adoption; publishing or dispatching alone is not an adoption receipt. Existing overdue-generation recovery remains responsible for an unknown dispatch. An unobserved source deployment is labelled as unobserved, not guessed from a publishing pin.

Reviewed native operational releases use the same preserved-turn fence and keep their original release/review identifiers. Native read_operational_code now exposes the matching private handoff receipts. No model-accessible arbitrary generation, deployment or credential tool is added.

Rollback rechecks the current enabled scope and exact release revision before starting and completing. A newer release or revoked scope cannot be overwritten. The previous deployment must pass its production health read before recovery is marked complete. Code rollback does not rewind application data, payments, claims, cursors or reservations.

Only four nullable handoff-evidence columns are added. No financial table or existing row is rewritten. General native/API Node-source authority, arbitrary SQL/migrations and new hook installation remain outside this release. Treasury, fee cap, transfer rules, allowances, stopped automations and existing social schedules remain unchanged.
