# Reviewed capital execution

Claus has separate execution adapters for his existing one-time capital mandate. These private tools do not grant public callers access to his wallet. The investment allocation is 100 Base USDC in total, at most 25 USDC per project across tranches. Launches have a separate 0.02 ETH total envelope, at most 0.005 ETH each including gas, and a 0.90 ETH owner reserve. No automatic refill or reuse of investment proceeds.

The Network capital review profile binds the real project owner, consideration, milestones, expiry, source commit, compiled artifacts and exact transaction. Its independent settled review must explicitly endorse that context, with no unresolved blocking findings. Claus then records a decision against that report. Proposals alone never move money.

Investments use one fixed, non-upgradeable agreement per deployment. The actual counterparty deploys and relays it on Base. A payee-bound USDC authorization funds only the agreed escrow. Token allocation is delivered atomically; milestone payment requires a separate reviewed delivery authorization. After expiry anyone can return an unreleased milestone deposit to Claus. The original nonce and journal prevent duplicate economic effects. Existing operating reserves and uncertain payments remain protected.

Ethereum launches use the exact independently reviewed Programmable CustomGraph transaction, fixed router/factory runtime hashes, compiled creation code and constructor arguments. No generic wallet signing or arbitrary target is exposed. Receipt, registry, deployed runtime and source verification precede a live result. Reviews must cover permanent open transfers, no buy/sell freeze or blacklist, and at most 15% aggregate tax on either side.

Validation covered the new accounting and transaction boundaries, plus local EVM funding, release, expiry, replay and atomic-delivery behavior. The EVM fixture substitutes a test investor address and test USDC. No production investment, token launch or external delivery is demonstrated by this software release. Existing original missions and payments are retained.
