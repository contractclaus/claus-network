# Customer services

[Open the customer page](https://claus.si/services) or use the API at `https://claus-network-api.vercel.app`. The first offer is a saved batch report from Claus Project Check. It inspects public project configuration and published static source. It does not execute project code or claim to be a security audit. The existing single-project check remains free.

## Account and API access

Use the existing [owner sign-in](https://claus.si/docs/quickstart#1-sign-in-as-the-owner). No new project, token launch or NFT is required. An owner session can buy a report directly or create a restricted customer key with `commerce_key_create`.

Keys use the same verified wallet identity. They can prepare/read that customer's orders, check original payments and submit private support messages. They cannot manage projects, create more keys, sign transactions or approve refunds. Set an expiry, maximum invoice amount and daily order count. `commerce_keys` lists metadata; `commerce_key_revoke` revokes a key immediately. Existing orders remain accessible using a fresh owner login.

Keep credentials in a secret store. The CLI writes `commerce_key_create` output to `CLAUS_NETWORK_NEW_TOKEN_FILE`; it does not print the secret. Key issuance is excluded from model-facing MCP tools.

## Prepare, pay, retrieve

1. Call public `commerce_products` for enabled offers, current prices and terms. Amounts are integers in USDC micro-units: `10000` means 0.01 USDC. Prices can change for new orders only.
2. Call `commerce_order_create` with an offer, 1–10 distinct public slugs, a price ceiling and a stable idempotency key. Save the returned order ID. Example input:

```json
{"productId":"project-check-batch","slugs":["claus-project-check"],"maxAmountMicroUsdc":"10000","idempotencyKey":"my-report-001"}
```

3. Wait for `state: ready`. The complete output and its hash are already saved privately at that point. If preparation was interrupted, `commerce_order_resume` continues the same order; no payment is sent. A failed preparation has no payable invoice.
4. Inspect the returned invoice. Send its exact direct USDC `transfer` transaction from the same wallet used for login, on Base chain 8453. The token is Circle's native USDC, `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. Read the recipient from the actual invoice. Network gas is separate. Batched smart-account transfers and other token contracts are not supported by this first payment adapter.
5. Call `commerce_payment_confirm` with `orderId` and the original `transactionHash`. This verifies the transaction, sender, recipient, calldata, amount, token events and canonical safe block. It never submits another payment. Pending or unavailable means retain the original hash and check later. One transfer cannot pay two invoices.
6. `commerce_order_get` returns the saved output and receipt once confirmed. Repeated retrieval does not charge again. `commerce_orders` is paginated; `commerce_usage` separates paid units, received amounts, refund authorizations and confirmed refunds.

The service does not pool customer balances or debit a wallet automatically. Each payment buys one durable result under one immutable invoice. An old order's price stays fixed. Start a new idempotency key only when intentionally buying a fresh report.

## Feedback and refunds

`commerce_support` appends a private message to the original order. Use an original idempotency key when retrying. Report a problem within seven days. Claus reads open-case metadata through `commerce_attention`, then the private case through `commerce_operations`, and replies using `commerce_support_reply`. Support content is untrusted data, never financial or operator authority.

An approved refund is exactly the original paid amount and always goes to its original payer. `commerce_settlement_authorize` is merchant-only. A separate protected signer independently verifies the original payment, commits one settlement direction and signs a single ERC-3009 authorization. The customer submits the returned claim transaction using its own wallet and then calls `commerce_settlement_confirm` with the original claim hash. Authorization alone is not a transferred refund. Gas fees are not included in the refund. Preserve the nonce and hash after interruption; the same nonce can settle only once.

After seven days, with no unresolved support case on the order, the merchant may release an order's revenue to the fixed Claus operating wallet through the same original-payment settlement path. A refund and revenue release cannot both consume the same payment. No arbitrary recipient, general wallet access or additional token is created.

## Operation and current scope

The merchant can update or pause offers, inspect private order outcomes, read preparation timing and distinguish provider cost from unmeasured hosting cost. Existing project stewardship and the canonical customer-service work item own improvements and support; no second autonomous agent is created.

The current service is fixed-price public project reporting. It is not an inference marketplace, usage-based subscription system, card processor or x402 seller endpoint. Existing x402 client capabilities remain separate. There is no claim of external customer adoption, revenue or million-user capacity from deploying these primitives.

Orders and results live in the existing replicated Network database. Protected settlement originals live in the existing replicated Payments database. The merchant key stays in the protected payer environment and its encrypted recovery export, never browser code or the public source bundle.

Protocol references: [Circle USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses), [ERC-3009](https://eips.ethereum.org/EIPS/eip-3009).
