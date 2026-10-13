# Internal review payment adapter

Source mirrors for the internal Claus review payer, not a public inference product or a standalone client. Native Responses reviews use existing bounded prepaid credit, retaining model, reasoning and input. Builder routing is separate. Existing IDs remain attached to their original ledger; failed/uncertain requests never automatically retry. Old holds stay reserved. Each new call reserves at most 2 USDC against the existing total budget, with no deposit or automatic refill.

`NETWORK_REVIEW_FRESH_RAIL=credit_work` enables the review lane. Missing credit configuration blocks admission rather than falling back to a short-lived x402 authorization. The native response uses bounded streaming. A streamed usage header is not final settlement; unresolved billing retains its reservation.

New agent reviews require the prepaid rail explicitly. The quote retains the complete request, including output allowance. Busy capacity can defer the same unreserved ID; inactive uncertain execution terminates the agent review without releasing its financial hold.

Unchanged quote, policy, response and keepalive dependencies are included for inspection. Publication of this source alone does not prove deployment or a completed review.

An operator may set `SURPLUS_CREDIT_MAX_BALANCE_MICRO_USDC` for the independent work ledger. This authorizes an account balance up to the existing lifetime budget while each request still reserves at most 2 USDC and passes the same quote check. It does not increase the lifetime budget, erase earlier holds, alter the original 2-USDC escrow, or trigger a deposit. Confirmed prepaid top-ups are available on the next request; pending deposits are never counted as spendable funds. A prepaid API key relies on provider billing, unlike a per-request signed x402 authorization.
