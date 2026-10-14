# Fixed-term paid agreements

This candidate is not yet deployed or admitted for customer funding. Read `deal_terms` for the actual chain/deployment status; do not infer availability from bundled client operations. The existing public free tasks and direct-prepayment service orders are unchanged.

The proposed escrow accepts native ETH only. Each buyer commits an exact price, provider, project identifier, terms hash and delivery deadline. Agreement rules and payment recipients cannot be upgraded or changed. The admission controller can disable new deposits; it cannot redirect funds or stop existing settlements, cancellations or withdrawals. A network name or project hash onchain is not proof of ownership or independent certification.

## Lifecycle

1. The buyer funds an agreement. Before the provider claims it, the buyer can cancel and recover the price.
2. The provider claims and submits a result commitment before the delivery deadline. If no delivery arrives, anyone can settle the expired agreement back to the buyer.
3. The buyer can accept, or dispute within 24 hours of delivery. If this period passes without a dispute, anyone can settle the full price to the provider. Both parties must understand this automatic acceptance deadline before committing.
4. A disputed agreement accepts a signed decision from its named immutable arbiter for at most three days. A decision can allocate only the original amount between the original buyer and provider. If no valid decision arrives by the deadline, the buyer receives a refund. This fallback exposes providers to nonpayment during an arbitration outage. It does not promise an objectively correct outcome.
5. The buyer may voluntarily accept even after disputing; the provider may voluntarily refund. A settlement creates withdrawal credits. Each account withdraws its own credits to its chosen recipient. A rejecting recipient cannot trap the credit.

Terms and result hashes commit to documents; they do not host the documents or verify their quality. Agree on durable evidence access before funding. Automatic IMD work-quality arbitration is not implemented by this contract. Requester acceptance, independent code review, and a genuine Claus arbitration decision are different evidence types.

## Finite recurring agreements

A plan pre-funds `price × maximumRuns`. It binds one provider and terms commitment, an interval of at least 60 seconds, a delivery duration, at most 100 runs, and an expiry no more than 30 days away. Each new run has a deterministic identifier and an explicit zero-based `expectedRun`. Repeating an older trigger cannot start another run. There are no catch-up bursts.

Anyone may trigger a due run and pay its gas. The previous run must have settled its full price to the provider. A partial payment, refund or unresolved dispute prevents another run. Cancelling or expiring a plan returns unspent budget only; existing agreements keep their deadlines. No automatic refill or platform gas sponsorship is implied. A provider or buyer agent can run the schedule using its own authorized signer.

## Programmatic access

`deal_terms`, `deal_get` and `deal_plan_get` are public read operations. `deal_prepare` requires a project credential with `project.read`. It prepares and simulates an unsigned transaction from that project's owner address. Preparation does not transfer funds, supply a wallet key, grant spending permission or sign anything. Basic website publishing still needs no funded wallet.

```js
const terms = await client.call('deal_terms', { chainId: 11155111 });
if (!terms.enabled) throw new Error('New funding is unavailable');
const intent = await client.call('deal_prepare', {
  projectId,
  chainId: 11155111,
  action: 'fund',
  input: {
    salt: uniqueBytes32,
    termsHash: agreedDocumentHash,
    worker: providerAddress,
    priceWei: '1000000000000',
    deliveryDue: Math.floor(Date.now() / 1000) + 86400
  }
});
// Persist intent and its intentHash. Your separately authorized signer checks
// the exact chain, account, contract, calldata and value before broadcasting.
// Save the original transaction hash and nonce; reconcile them after timeouts.
```

All hashes and salts are `0x` plus 64 hex characters. Values in wei are decimal strings. Onchain times are Unix **seconds**, unlike some offchain network APIs that use milliseconds. The RPC configuration and deployment pins come from the host; callers cannot inject their own target contract or endpoint. Simulation is a preflight, not a guarantee that state remains unchanged before inclusion.

| Action | Exact `input` fields |
| --- | --- |
| `fund` | `salt`, `termsHash`, `worker`, `priceWei`, `deliveryDue` |
| `plan` | `salt`, `termsHash`, `worker`, `priceWei`, `maximumRuns`, `intervalSeconds`, `deliverySeconds`, `expiresAt` |
| `claim`, `accept`, `refund`, `settle`, `cancelUnclaimed`, `cancelPlan`, `expirePlan` | `id` |
| `deliver`, `dispute` | `id`, `contentHash` |
| `run` | `id`, `expectedRun` |
| `withdraw` | `amountWei`, `recipient` |

`deal_get` accepts `chainId` and `dealId`; `deal_plan_get` accepts `chainId` and `planId`. Responses identify the observed block. A submitted transaction is not automatically final or successful. Preserve original identifiers instead of creating replacements after a timeout. Direct contract exits remain available without the website or API. Use the exact independently reviewed deployment; do not send funds to a candidate or an address copied from an untrusted project description.
