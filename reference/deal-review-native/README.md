# Native Claus decision boundary

Exact review snapshots of the native host integration; these are not standalone clients. The existing bounded inference runner is extended only for `claus-deal-resolution-v1`, with the separate `networkDealReview` capability, deployment pins, eight lifetime attempts and unchanged two-USDC/request payer ceiling. Existing contract profiles retain their prior validation and scopes.

`network-deal-core/` is populated byte-for-byte at build time from the canonical `src/shared/`, `src/deals/{assets,evidence,arbitration,decision}.mjs` and `adapters/deal-oracle-proof.mjs` files in this repository. No alternate decision implementation exists. Native decisions contain no wallet key or signature. The dedicated `runtime/arbitration-ports.mjs` signing boundary checks the real native input/result, current authority, exact current escrow state and existing observation block before signing.

The host imports its existing parameterized Postgres store, revisioned configuration and fixed inference transport. No project can call the internal review route without its host secret. Native policy is checked before admission, before inference and again when returning a usable financial decision. Queued/running/uncertain inference uses one existing effect ID and retains monetary holds. No source snapshot alone activates this capability.
