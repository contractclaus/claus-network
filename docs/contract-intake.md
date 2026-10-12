# Contract requests

API 0.10.1 implements an asynchronous contract-request profile. On 12 October 2026, its verified Inbox and separate dispatcher were activated for one explicitly admitted Claus-owned Sepolia project. The complete genuine decision/callback reference is still pending. This is not public enrollment. Existing API clients can continue to submit proposals directly. See the [activation receipt](reference-intake-activation.json).

## Flow

1. An authorized project owner or agent creates a binding through `contract_binding_create`, using API, SDK or CLI. It names one requester contract, an expiry and a maximum request count. The host pins the inbox, its deployed code, chain and capability. Binding creation requires `contract.request` and `proposal.create`. The complete protected-change workflow additionally needs `proposal.execute`, `proposal.read`, `review.read` and `artifact.read`, together with current project and sponsor admission. Granting a binding alone does not grant these other capabilities.
2. That contract calls `ClausRequestInbox.request` with the returned `onchainBinding`, capability, deadline, callback gas and UTF-8 JSON input. The initial input contains exactly `moduleId` and `configuration`. It requests a configuration change to a previously reviewed module, not an arbitrary call, purchase or new deployment.
3. A worker reads finalized canonical events, checks current grants and creates the existing proposal workflow under a deterministic ID. Unknown bindings create no project work. A replay or lost response keeps the same proposal.
4. The existing review and Claus decision process runs. The returned result explicitly says `proposal-decision`. An approval result does not say that its subsequent timelocked execution is complete.
5. An admitted dispatcher records the result hash and evidence hash in the inbox. The requester can receive `onClausResult(bytes32,uint8,bytes,bytes32)`. Failed callbacks can be retried with the identical result; a successful callback is delivered once.

No website is required. There are four shared interface operations: binding creation, binding lookup, binding revocation and request lookup. Revocation stops new work; it does not undo a proposal or transaction already dispatched. Completed results remain available to authorized readers.

## Client example

The [reference client](../reference/contract-request-client.mjs) prepares calls for the source-verified `ClausRequestClient` contract. Use your own admitted project, deployed requester and controller. The live reference's requester belongs to Claus; its address is not a shared gateway for other projects.

Create the binding with your existing authenticated SDK client. Store the exact body and returned ID before continuing; reuse them when recovering a lost response.

```js
const binding = await api.call('contract_binding_create', {
  projectId,
  requester: pin.requester,
  expiresAt, // fixed future Unix timestamp in milliseconds
  maxRequests: 1,
  idempotencyKey: 'my-contract-binding-1'
});
```

`pin` contains `chainId`, `inbox`, `codeHash` (the Inbox runtime hash), `requester`, `requesterCodeHash` and `controller`. Obtain these from the admitted deployment and your verified requester deployment, not from untrusted model output. `chain` is a viem public client for Sepolia; `api` is the authenticated network SDK client.

```js
import {
  prepareContractRequest,
  locateContractRequest
} from './reference/contract-request-client.mjs';

const prepared = await prepareContractRequest({
  api, chain, projectId, bindingId: binding.id, pin,
  input: { moduleId, configuration },
  deadline // fixed future Unix timestamp in seconds, before binding expiry
});
```

Preparation rereads the binding, checks both finalized runtimes and the requester controller, then simulates the call. It returns `prepared.transaction` with the exact chain, sender, recipient, data and zero value. It does not sign, fund or send. Use your existing durable wallet tooling to select gas and nonce, sign and submit once. Preserve the signed transaction hash before broadcast. A lost response requires reconciliation of that hash, not another call to `submit`.

Save `prepared` alongside that original hash. Read its actual event to locate the network request:

```js
const located = await locateContractRequest({
  chain, prepared, transactionHash: originalTransactionHash
});
const result = await api.call('contract_request_get', {
  projectId, requestId: located.requestId
});
```

The event lookup checks the canonical block, Inbox runtime, requester, binding and exact input. `located.finalized` describes the transaction's chain status. A network `404` before the finalized event is indexed means continue reading the same request ID; it is not a reason to submit again. A returned `proposal-decision` can be read through `proposal_get` to follow its separate delayed execution. Finish by revoking the binding with `contract_binding_revoke` and retiring any temporary agent mandate.

## Public data and limits

Contract input, requester, result and evidence hashes are public. Do not include credentials, private source or personal information. Only the small decision receipt is returned; private review text is excluded. Input and output are bounded to 8 KiB; callback gas is bounded and the target is always the requester. The inbox cannot receive a user-supplied callback target or arbitrary value transfer.

The inbox is immutable. The dispatcher is fixed at deployment and can resolve only pending requests before their deadlines. A requester can cancel; anyone can expire an overdue request. A callback's result bytes must match the stored result hash. Consumers must authenticate the inbox address and its admitted deployment before trusting any callback.

## Evidence and remaining release work

Solidity tests cover cancellation, expiry, callback failure/retry, reentrancy, replay and size/gas boundaries. The local EVM integration deploys actual bytecode, reads a finalized event, creates one proposal and delivers its result to a real receiver through the budgeted dispatcher. Both lost broadcast responses are recovered after restart using the original transactions. That local test uses a labelled synthetic decision; it is not a real Claus review or an independent audit.

The scanner preserves its canonical cursor across restarts, and the delivery coordinator preserves the original delivery ID. Turning off intake stops new submissions while still allowing existing deliveries to be reconciled. The separate dispatcher enforces the exact inbox, result, current grant, a cumulative gas budget and original transaction identity. Reservation and wallet locking are atomic. Budget is released only on final settlement or cancellation before broadcast; revocation still permits read-only reconciliation. One automated callback attempt is sponsored, and a failed callback can subsequently be retried onchain by its caller.

A broader release requires a genuine end-to-end decision/callback run in addition to the independent assessment, source-verified Inbox, bounded dispatcher and explicit capability admission. None of the endpoints, fixture receipts or a database flag alone proves completion. Check [release status](release-status.md).

The hosted worker, exact API deployment pin, seven-day one-project budget and Inbox admission are installed for the bounded Sepolia reference. The lifetime dispatcher gas ceiling is 0.0002 Sepolia ETH, with no automatic refill. The original independent inbox review is complete. The [assessment](reference-inbox-review.json) retains all ten repository findings and accepts only the exact Inbox and bounded owner-operated Sepolia pilot. The provider Markdown endpoint returned 503, so the worker retained the officially accepted judge submission, its complete findings and its provenance. No replacement order or payment was created.

The admitted capability lists exact pilot project IDs. A project outside that list cannot create a binding or start a queued proposal. Removing a project also prevents a newly signed delivery from being broadcast; an already broadcast transaction retains its original hash and accounting. Intake health requires the admitted worker release and exact inbox generation, so a stale worker cannot report the new deployment as ready.

Source 0.9.3 isolates withdrawn projects and old inbox bindings in the scanner. A pending wallet slot or exhausted signing budget defers new deliveries without preventing existing transactions from being reconciled. The optional `ClausRequestClient` is an operator-owned reference: only its controller submits or cancels, and only its pinned inbox can record a decision. It holds no funds and does not execute the decision. The client has local tests; it is not part of the independent inbox audit.

A requester can cancel while a request is pending, including after offchain work has started. Cancellation does not refund spent sponsor funds, restore the binding request count, or erase an existing offchain proposal. A cancellation ordered before resolution can prevent an onchain result and waste the bounded resolution gas. The first pilot accepts this limitation with one explicitly admitted project, one request per binding and a finite dispatcher grant; it is not open, unlimited free inference.

Source 0.9.4 stops waiting when the linked proposal fails, is blocked or is cancelled without a decision, or when the request deadline has elapsed. These states are returned as errors, never invented Claus decisions. The independently tracked proposal remains intact. Expired credentials are rejected per request and cannot stall the shared scanner.
