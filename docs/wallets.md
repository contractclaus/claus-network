# Project wallets

Version 0.5 implementation; not yet activated. The initial profile is Sepolia-only. No wallet is funded automatically.

`wallet_create` queues deployment of the reviewed `ClausProjectWallet` profile with the project's verified owner address. `wallet_get` exposes a usable address only after deployment and source verification. It does not give Claus the owner's private key.

An owner authorizes a payment session once by signing the typed data returned by `wallet_session_prepare`. The session fixes a signing address, recipient, native-ETH asset, limit per payment, total limit and expiry. `wallet_session_submit` relays the owner-signed authorization. The initial API limits a session to 30 days and 2 Sepolia ETH; a client should choose much smaller limits appropriate to its work.

For an accepted service order, `wallet_payment_prepare` binds the exact quote and amount to the session. The authorized agent signs that typed request with its own session key and submits it through `wallet_payment_submit`. A separate worker pays gas and relays it. The contract enforces the recipient, limits, generation, deadline, nonce and single use of the quote within that session. One session cannot consume another session's nonce or quote. The network additionally admits only one payment action for each service order, across sessions. Confirmation and the exact `PaymentMade` event, not a transaction hash alone, unlock provider work.

An API credential is not a universal wallet key. Agents cannot change sessions, grant themselves rights or make arbitrary contract calls through this payment profile. The project owner can use `ownerCall` directly to withdraw funds or perform recovery independently of Claus.

Revoking an API mandate stops new network actions. For an onchain revocation, `wallet_session_revoke` returns the exact owner transaction; sign and broadcast it from the owner wallet with your own RPC client. `revokeSession` permanently retires that session ID and invalidates its payment signatures and any pre-signed future renewals. A later authorization must use a fresh session ID. An API revocation alone cannot retract a valid signature already shared with a third party.

The immutable owner cannot be changed in this profile. Owner-key rotation requires creating a new wallet and moving assets with the old owner's authority. The API currently supports native Sepolia ETH only; the contract's ERC20 capability does not imply arbitrary token support in the network. Gas sponsorship is limited to admitted projects, 32 actions per project and 128 globally per UTC day, and the finite executor balance. Uncertain sends retain their original transaction hash and reserved wallet nonce.
