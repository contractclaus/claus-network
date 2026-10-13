# Review delivery correction

Long internal reviews use the existing prepaid payment adapter. The former x402 path allowed a 600-second model response while the signed authorization expired after 120 seconds. One retained failure was decoded as `SignatureExpired(uint256)`. Prepaid delivery removes that mismatch without extending signatures or repeating prior requests. No public inference access is enabled.

A project-specific, operator-only recovery allocation can temporarily set `maximumGlobalDay` from 8 to 16 inclusive. It expires with its existing UTC-day allocation, preserves every historical counter and the global lifetime maximum of 32, and does not fund model use. Other projects keep the ordinary global-day ceiling. Invalid values invalidate the allocation. The agent has matching operator deployment settings `NETWORK_REVIEW_RECOVERY_DAY` and `NETWORK_REVIEW_RECOVERY_LIMIT` (8 through 16, otherwise 8). They grant no approval authority.

The planned delivery uses at most two further decisions and a dated ceiling of 10, only after the prior attempts are conclusively failed. Each remains subject to the existing 2-USDC per-call and 500-USDC lifetime payer limits, original proposal evidence, actual model decision and signature verification. There is no automatic retry, refill, counter reset or change to customer permissions.
