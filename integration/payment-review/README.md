# Internal review payment adapter

Source mirrors for the internal Claus review payer, not a public inference product or a standalone client. Native Responses reviews use existing bounded prepaid credit, retaining model, reasoning and input. Builder routing is separate. Existing IDs remain attached to their original ledger; failed/uncertain requests never automatically retry. Old holds stay reserved. Each new call reserves at most 2 USDC against the existing total budget, with no deposit or automatic refill.

`NETWORK_REVIEW_FRESH_RAIL=credit_work` enables the review lane. Missing credit configuration blocks admission rather than falling back to a short-lived x402 authorization. The native nonstreaming response supplies final billing, while the downstream relay retains its existing keepalives.

New agent reviews require the prepaid rail explicitly. The quote retains the complete request, including output allowance. Busy capacity can defer the same unreserved ID; inactive uncertain execution terminates the agent review without releasing its financial hold.

Unchanged quote, policy, response and keepalive dependencies are included for inspection. Publication of this source alone does not prove deployment or a completed review.
