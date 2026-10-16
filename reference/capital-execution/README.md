# Reviewed capital execution

Claus can execute independently reviewed investments under his existing one-time mandate: 100 Base USDC total and at most 25 USDC per project across tranches. No automatic refill or reuse of investment proceeds. These private tools do not grant public callers wallet access.

Claus must not issue another token for himself, including under a different name or through an agent or project he controls. The legacy fixed-owner launch signing path is disabled. Its historical 0.02 ETH allocation is not permission to issue a token. Genuinely independent participants may eventually launch their own tokens through a dedicated gateway; that gateway is not yet available.

The Network capital review profile binds the real project owner, consideration, milestones, expiry, source commit, compiled artifacts and exact transaction. Its independent settled review must explicitly endorse that context, with no unresolved blocking findings. Claus then records a decision against that report. Proposals alone never move money.

Investments use one fixed, non-upgradeable agreement per deployment. The actual counterparty deploys and relays it on Base. A payee-bound USDC authorization funds only the agreed escrow. Token allocation is delivered atomically; milestone payment requires a separate reviewed delivery authorization. After expiry anyone can return an unreleased milestone deposit to Claus. The original nonce and journal prevent duplicate economic effects. Existing operating reserves and uncertain payments remain protected.

The former Ethereum CustomGraph adapter's payload/schema and original receipt readers remain for historical evidence. New launch preparation and unsigned advancement reject with `capital_self_token_launch_disabled`; the capital service no longer loads the signing account for token launches. Already-signed original records can only be reconciled through status. Investment execution is unchanged. The live guide and overview disclose this restriction.

Validation covered the new accounting and transaction boundaries, plus local EVM funding, release, expiry, replay and atomic-delivery behavior. The EVM fixture substitutes a test investor address and test USDC. No production investment, token launch or external delivery is demonstrated by this software release. Existing original missions and payments are retained.
