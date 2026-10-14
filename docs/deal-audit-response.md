# Paid agreement candidate corrections

The independent IMD job `b9c4399e-2616-411c-86e3-415b1e889f29` reviews source `935c323e5190ce9806e1b844a3644b5519200487`. Its specialist findings informed the corrections below. This document does not claim that the corrected source has completed an independent review or that an escrow is deployed.

| Finding | Correction or retained boundary |
|---|---|
| Requester session expiry or revocation vetoes a case | Admission creates one durable network-sponsored review for the original onchain parties. The requesting credential is checked at admission and retained for attribution. It cannot later cancel the obligation. Operator generation/revocation and fresh onchain state remain enforced. |
| Buyer can withhold a dispute preimage | Matching public terms and result remain required. An absent or wrong-kind buyer objection is explicitly represented in the frozen bundle. Neither the panel nor Claus may treat that absence alone as non-delivery or a reason to deny the review. Insufficient objective delivery evidence still cannot authorize a payout. |
| Trivial self-dealt disputes exhaust the subsidy | Subsidized cases require at least 0.0001 ETH, one case per owner per UTC day and at most two per owner in the eight-case allocation. Project/global bounds remain. Different identities are not proof of different operators; the finite subsidy can still be exhausted. |
| Late admission leaves no time for processing | New cases require three hours remaining. Existing processing retains its one-hour margin. This adds room for asynchronous work without promising completion in a fixed time. |
| Never-submitted quote reservations remain held | Expired unpaid quotes fail the original case. A database-fenced abandonment releases only locally proven never-submitted payment states. Submitted, broadcasting and unknown states retain their original orders and full holds pending verified settlement. No replacement purchase is automatic. |
| Missing or inconsistent maximum in escrow pins | The configured decimal ceiling is mandatory and must match the immutable chain value before case admission. The native validator checks the same equality and produces a typed rejection. |
| Scheduler absent from the main API deployment | The signer worker is a separate private deployment. `deploy/deals.vercel.json` supplies its minute cron. Public discovery includes heartbeat evidence, and new admission rejects a worker not observed within five minutes. |

The escrow Solidity source is unchanged by these corrections. Original contract review, exact compiler input, signatures and transfer evidence retain their original identities. The original buyer-refund timeout, provider monitoring obligation, immutable arbiter and limited signer trust remain explicit in [paid agreements](paid-deals.md).
