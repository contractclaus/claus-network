# Network session recovery

Native25 and Signer15 fix a two-cache authentication loop. Previously a rejected API session was cleared in Native, but the custody service could return its own cached copy of the same rejected session on the next request. A late 401 from an older request could also discard a newer session.

Native now retains a SHA-256 fingerprint of the session rejected by the Network API. On its next authenticated operation, it supplies that fingerprint to the fixed custody session route. Custody invalidates its cache only when the fingerprint matches the current session, and concurrent callers share the same login. Neither service lets an old response invalidate a newer session. Native refuses to send another operation if custody returns the known rejected session again.

The route still accepts the original empty body. The only additional input is an optional 64-character session fingerprint. It accepts no address, host, message to sign, wallet destination or transaction. Authentication and the existing custody enabled gate remain required. The login key stays in the fixed custody service.

No project mutation, job action, payment, or unknown result is retried by this change. The first failed call remains failed; a subsequent caller uses the recovered session and must preserve the original action's idempotency and recovery rules. A disabled service is not re-enabled.

Five focused cases cover cache coalescing, stale-response races, input/authentication gates, refused-session responses and no write replay. A staged real session successfully read the existing Network identity. This authenticates the current identity; it does not prove a new external job, new payment, broader source authority or production database recovery.

No database schema, key, fee, recipient, mainnet call, paid review, schedule, or public client operation changed. Native's editable paths remain only `src/isolated/network.json` and `src/isolated/work.json`; API's remains only `src/isolated/network.json`.
