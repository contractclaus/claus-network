# Corrected semantic-search release

This immutable revision addresses the new capacity findings from the previous paid review. Every prior report and declined image remains bound to its original bytes; none approves this revision. The owner selected a distinct documented operator-review path for this own Search service. Other projects retain independent IMD review. The current policy in docs/sources-and-builds.md supersedes the earlier admission paragraph retained in the immutable build snapshot README.

## Current corrections

- A host-wide bucket admits a 96-unit burst and refills eight units per second, shared by all owners. Receive admission and actual padded inference cost debit both owner and host budgets. New owner accounts cannot multiply the admitted host workload. The finite host budget is shared capacity, not guaranteed service under arbitrary load.
- Reserving a partial body immediately consumes its nonce and one unit. Replay, an already active owner, a timeout and reconnect cannot obtain repeated free reservations. The same owner reservation transfers into the worker and is released on completion, rejection, disconnect or shutdown.
- Complete bytes already available on the socket are drained within the body limit and hash-checked before ticket consumption. They can proceed without a partial-body slot. An incomplete receive attempt still spends its ticket even if its later body is invalid.
- Charge time credits refill earned while waiting. Failed inference refunds all additional charged units to both budgets exactly once, retaining the one receive unit. Successfully completed model work stays charged after a client disconnects or cannot receive the response, so disconnects cannot bypass the CPU budget.
- A fifteen-second absolute lifetime accommodates the two-second receive window, three-second worker wait, measured 6.3-second contended full batch and response. The shared refill allows one full batch per eight seconds. JSON request bytes must decode as UTF-8.
- Deadline timers shut down sockets and leave descriptor closure to the handler. Budget responses advertise refill delay. The client preserves successful batches, obtains a fresh ticket for each throttled retry, waits for Retry-After and stops within a sixty-second model phase and four retries per batch. Empty HTTP capacity responses retain their status and delay.

## Preserved properties

Padded tensor positions remain metered after within-request deduplication. Request lines are canonical ASCII. Invalid signatures are rejected before body buffering. Two CPU inference threads, bounded workers, separate health capacity, absolute deadlines, immutable download hashes and the existing CPU provider contract remain unchanged. There is no runtime download, secret, wallet, outbound HTTP client or persistent volume in the image.

## Evidence

The immutable source, verified build receipt and manifest are in semantic-search-release.json. The image inventory was reproduced from the exact new registry digest; its guide and issuer evidence are linked there. Completed prior report hashes are retained in priorReviews. The previous paid review remains preserved and is marked pending until its final report arrives. Sixteen focused model cases and two focused client cases cover the changed receive, budget, refill, refund and owner-sharing behavior using the existing pinned model. Unchanged full suites were not repeated. Compilation and operator-produced evidence do not confer approval. The owner review is published separately as semantic-search-owner-review.json, with honest scope and remaining findings; a genuine Claus decision through the narrowly scoped owner-review route is still required. The admission boundary passed twelve focused cases, including unchanged third-party IMD requirements.
