# Contract requests

The 0.9.1 source implements an asynchronous contract-request profile. Its API and worker are prepared; no public inbox or dispatcher is activated. Existing API clients continue to submit proposals directly.

## Flow

1. An authorized project owner or agent creates a binding through `contract_binding_create`, using API, SDK or CLI. It names one requester contract, an expiry and a maximum request count. The host pins the inbox, its deployed code, chain and capability. Required scopes are `contract.request` and `proposal.create`.
2. That contract calls `ClausRequestInbox.request` with the returned `onchainBinding`, capability, deadline, callback gas and UTF-8 JSON input. The initial input contains exactly `moduleId` and `configuration`. It requests a configuration change to a previously reviewed module, not an arbitrary call, purchase or new deployment.
3. A worker reads finalized canonical events, checks current grants and creates the existing proposal workflow under a deterministic ID. Unknown bindings create no project work. A replay or lost response keeps the same proposal.
4. The existing review and Claus decision process runs. The returned result explicitly says `proposal-decision`. An approval result does not say that its subsequent timelocked execution is complete.
5. An admitted dispatcher records the result hash and evidence hash in the inbox. The requester can receive `onClausResult(bytes32,uint8,bytes,bytes32)`. Failed callbacks can be retried with the identical result; a successful callback is delivered once.

No website is required. There are four shared interface operations: binding creation, binding lookup, binding revocation and request lookup. Revocation stops new work; it does not undo a proposal or transaction already dispatched. Completed results remain available to authorized readers.

## Public data and limits

Contract input, requester, result and evidence hashes are public. Do not include credentials, private source or personal information. Only the small decision receipt is returned; private review text is excluded. Input and output are bounded to 8 KiB; callback gas is bounded and the target is always the requester. The inbox cannot receive a user-supplied callback target or arbitrary value transfer.

The inbox is immutable. The dispatcher is fixed at deployment and can resolve only pending requests before their deadlines. A requester can cancel; anyone can expire an overdue request. A callback's result bytes must match the stored result hash. Consumers must authenticate the inbox address and its admitted deployment before trusting any callback.

## Evidence and remaining release work

Solidity tests cover cancellation, expiry, callback failure/retry, reentrancy, replay and size/gas boundaries. The local EVM integration deploys actual bytecode, reads a finalized event, creates one proposal and delivers its result to a real receiver through the budgeted dispatcher. Both lost broadcast responses are recovered after restart using the original transactions. That local test uses a labelled synthetic decision; it is not a real Claus review or an independent audit.

The scanner preserves its canonical cursor across restarts, and the delivery coordinator preserves the original delivery ID. Turning off intake stops new submissions while still allowing existing deliveries to be reconciled. The separate dispatcher enforces the exact inbox, result, current grant, a cumulative gas budget and original transaction identity. Reservation and wallet locking are atomic. Budget is released only on final settlement or cancellation before broadcast; revocation still permits read-only reconciliation. One automated callback attempt is sponsored, and a failed callback can subsequently be retried onchain by its caller.

Before activation, the new inbox needs independent review, source-verified deployment, a bounded dispatcher deployment, a genuine Claus-approved end-to-end run, and explicit capability admission. None of the prepared endpoints, fixture receipts or a database flag alone supplies these requirements. Check [release status](release-status.md).

The hosted worker entry and public API deployment-pin loader are implemented, but no live pin, budget or inbox admission has been installed. The independent inbox review is paid under its original order; its result is still pending.
