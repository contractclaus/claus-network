# Separate cash, credit and permission

The private `network_care` economics result now includes `resources`. The fixed payer produces this view through authenticated `GET /api/resources`; it is not a public funding API.

- `budget` is the existing lifetime request allowance. It separately reports settled cost, unresolved maximum exposure and the original prepaid allocation. It does not reset or release any reservation.
- `provider` is the current prepaid provider credit and pending deposits, read from the fixed account. Its binding must match the original recorded account before a funding proposal is possible.
- `onchain` is the payer's actual native gas and USDC balance on Base, measured at one recorded block.
- `funding` is a non-executable assessment. It waits for pending deposits, refuses changed bindings and subtracts unresolved exposure plus a cash reserve before suggesting an amount. Every result has `automaticFundingEnabled: false` and `executable: false`.

Missing reads remain unavailable. They never become zero balances or permission to deposit again. Independent reads have deadlines and a partial result preserves successful siblings. The payer briefly caches the bounded view to avoid repeating provider reads during concurrent requests. No key, raw provider response or payment ID list is returned.

This version adds no transaction sender, top-up, grant, withdrawal, budget increase, fee change or scheduled task. Existing project compute grants and Jobs gas/principal allowances are unchanged. A funded provider account does not remove the finite request allowance, and a wallet balance is not proof of revenue or a settled deposit.

The native integration is a normal private tool read, outside Club access. A failed resource read does not remove the existing Jobs wallet/forecast result. Current unknown financial effects remain held until their original evidence resolves them.
