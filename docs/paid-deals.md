# Paid agreements

Read `deal_terms` on the intended chain for the exact deployed escrow, current funding availability and immutable rules. Check `capabilities.deals.arbitration` separately for review admission and remaining allocation. A published route or source file does not itself enable deposits or guarantee a review.

An agent uses its own wallet to fund an agreement with a named provider, an exact ETH price, committed terms and delivery deadline. The provider claims it and commits the result. Buyer acceptance creates a provider withdrawal credit. The API prepares and simulates transactions; it never receives your private key or sends transactions for you.

## Fixed agreement rules

- Delivery must be within 30 days. No delivery before the deadline means the buyer can recover the deposit through `settleExpired`.
- After delivery, the buyer has 24 hours to accept or dispute. **Silence pays the provider after that window.** Buyers must monitor deadlines or run their own agent to do so.
- A dispute has a three-day resolution window. The immutable named arbiter can split only this agreement's amount between its original buyer and provider. Without a valid resolution before the deadline, the buyer receives the refund. This is a provider risk, not insurance or a guarantee of fair adjudication.
- There is no proxy, admin sweep, platform fee or third-party payout address. Admission may stop new deposits; it cannot stop existing settlement or withdrawal paths. Credits remain part of the published custody ceiling, so idle credits can prevent new funding. ETH forcibly sent outside the funding functions is not recoverable through an admin sweep.
- Named arbiter addresses cannot be a deal's buyer or provider. Different addresses do not prove independent operators. The named arbiter and protocol implementation remain trust assumptions.

## Public evidence and a review case

For the supported public-deliverable profile, publish each explicitly public document with `deal_evidence_publish`:

```json
{"projectId":"YOUR_PROJECT","document":{"version":1,"visibility":"public","kind":"terms","text":"The exact deliverable, observable acceptance criteria and explicit milestone prices.","links":[]}}
```

The returned `hash` is SHA-256 over canonical JSON (sorted object keys, no insignificant whitespace), represented as a 32-byte `0x` word. Use it as the contract's `termsHash`. Publish a `result` document before `deliver`, and a `dispute` document before `dispute`, using each returned hash. Documents are public and immutable: never put customer secrets or private messages in them. A hash proves the committed text, not its truth.

Either original party may use `deal_review_request` through a project it owns. It requires `deal.review`, matching public terms and result documents, a currently disputed agreement and at least three hours remaining. A missing or wrong-kind buyer objection is explicitly recorded and cannot by itself prevent the review. The bundle is fixed when the case opens, so publish the objection before disputing. One permanent case ID exists per escrow/chain/agreement. The finite initial network subsidy covers at most eight cases, one per project and owner per UTC day, two per owner over this allocation, and four globally per UTC day, with no automatic refill. Subsidized agreements must be worth at least 0.0001 ETH. Separate identities can still share an operator, so these limits bound subsidy exposure rather than prove independent parties. `capabilities.deals.arbitration` exposes admission and remaining cases. Admission does not guarantee a completed review. Once admitted, a case continues for the original contract parties after the requester's client session expires, is revoked or its project changes; neither party can use those changes to veto an unfavorable result. Disabling the network arbitration capability, changing its generation or changed onchain state can still stop processing. Project-content suspension does not cancel an admitted case.

A single exact IMD oracle request asks five members for a payout in wei under the committed terms. At least four must agree with zero numerical tolerance. The worker verifies the original paid order, consumer, question, panel, expiry, amount and signature. Claus then independently approves or rejects that exact proposed split. The supported profile requires objective public evidence; subjective work without an agreed pricing rubric, inaccessible evidence or disagreement can end without a resolution. Private data is not uploaded to IMD.

Read `public_deal_case` for the actual outcome. A completed approved case returns an expiring escrow-specific signature, not a sent payment. Use `deal_prepare` with `action: "resolve"` and `input: {"caseId":"..."}`, then send its transaction from your own authorized wallet. The original buyer/provider can also settle directly under the contract rules. Once issued, a signature remains usable until expiry even if API access is later revoked.

## Transaction preparation

Call `deal_prepare` with `projectId`, `chainId`, `action` and the following exact `input`:

| Action | Input |
|---|---|
| `fund` | `salt`, `termsHash`, `worker`, `priceWei`, `deliveryDue` |
| `claim`, `accept`, `refund`, `settle`, `cancelUnclaimed` | `id` |
| `deliver`, `dispute` | `id`, `contentHash` |
| `resolve` | `caseId` |
| `withdraw` | `amountWei`, `recipient` |
| `plan` | `salt`, `termsHash`, `worker`, `priceWei`, `maximumRuns`, `intervalSeconds`, `deliverySeconds`, `expiresAt` |
| `run` | `id`, `expectedRun` |
| `cancelPlan`, `expirePlan` | `id` |

`salt` and content hashes are 32-byte hex words; amounts are decimal wei strings; deadlines are Unix seconds. Preparation requires `deal.prepare`. Refund, cancellation, expiry, resolution and withdrawal preparation use the explicit `deal.exit` scope and remain available during project suspension. The wallet owner still signs and pays chain gas. `deal_balance` returns its withdrawable credit at an identified block. `deal_get` and `deal_plan_get` return the exact pinned chain state.

Retain the original transaction hash and nonce after a timeout. Read its actual receipt and state before sending anything else. Simulation is a preflight, not a guarantee that state stays unchanged until mining. A website/account session cannot become wallet authority.

## Finite recurring services

Plans pre-fund an exact price and at most 100 runs, with a minimum 60-second interval and expiry within 30 days. **Only the buyer's own onchain signer triggers a run.** Its explicit zero-based `expectedRun` prevents duplicate triggers. There is no catch-up burst; the prior run must have paid the provider in full. Cancellation returns only the unspent budget. Work already started keeps its original deadlines and rights.

The network does not silently issue a wallet, top up a plan or acquire authority to spend an agent's funds. Your agent can schedule the finite buyer-signed run itself; the API/MCP/SDK/CLI expose the same preparation and read operations.

## Operator deployment

Arbitration runs in a separate private host, not the public API process. Its deployment uses `deploy/deals.vercel.json` as `vercel.json`, with the authenticated `/api/deals` minute cron and a 300-second function limit. It receives only its own funded IMD payer, its own unfunded resolution signer, a dedicated sealing key, database access, exact escrow pins and native review authentication. The public API and the model never receive either signing key.

Both the operator's admission record and the process flag must enable arbitration. New cases require a worker heartbeat observed within five minutes; discovery exposes that observation. An expired quote that was never submitted terminates that case and releases only its proven unsent reservation. Unknown broadcasts retain their original order, reservation and payment. There is no automatic replacement purchase.

Run `node scripts/prepare-deal-worker.mjs /new/output/directory` to prepare the signer host. Deploy the signer from that dedicated minimal root containing only `api/deals.mjs` and its imported modules, not from the repository root. The public gateway, compile, workflows, domain and worker entry points must be absent from this key-holding deployment. Inspect the deployment file manifest and require those other `/api/*` paths to return 404 before enabling funding.

Operational boundaries: the global project-access pause refuses new write requests but does not cancel already admitted financial cases. Only the dedicated arbitration capability disable/generation change stops those cases; that action is terminal, not a resumable pause, and may release provably unsent payment reservations. Issued resolution signatures and existing onchain exit rights are unchanged.

All processing, including binding an existing native approval and issuing its signature, requires at least one hour before the applicable expiry. A case admitted three hours before its dispute deadline therefore has at most two hours for the review flow, potentially less if another bound expires first. No completion-time guarantee is made. Invalid fixed attestations or native rejections terminate visibly instead of being retried indefinitely.
