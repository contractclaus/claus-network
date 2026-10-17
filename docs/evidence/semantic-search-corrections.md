# Corrected semantic-search release

This source also corrects the two material findings from review 23937976-5f02-4196-916a-92dccd5a4a87. Every prior report remains valid for its original bytes; none is presented as approval of this revision.

The model's immutable build, source and manifest are in semantic-search-release.json. The reference client now pins that same release. No runtime approval or hosting is inferred from a build.

## Latest review corrections

- The inference meter counts padded tensor positions, since ONNX computes the padded rows too. A mixed long/short batch cannot obtain full-batch computation for the short-text price. Deduplicated rows are still charged only once.
- Temporary receive reservations are limited to one per owner and nonce and at most half the overall queue. Header and health capacity remains available; dispatch, timeout, disconnect and shutdown free the reservations. The ticket remains unconsumed until its complete body is admitted.
- Verified incomplete requests cannot be evicted by anonymous connections. At saturation an unverified request is evicted, or the newcomer is refused when all queued requests are verified.
- Token cost is reserved after acquiring the inference worker and is returned if inference fails. A rejected busy request consumes only its one admission unit and one-use ticket.
- Granting service.call explicitly includes the owner's shared search capacity. Pre-dispatch status reasons are canonical; deterministic 4xx rejections do not instruct clients to retry.

## Preserved prior fixes

1. Canonical ASCII HTTP lines are enforced before body routing. Signature verification happens before anonymous body buffering; nonce consumption stays after the complete body.
2. The CPU reference adapter accepts an explicit host-owned CPU configuration, exposes the 8080 HTTPS proxy, checks health and preserves the original pod on repeated create/stop. The actual deployed broker and driver are in reference/runtime-custody, with exact source hashes and deployment identity. They were already the production path; no provider keys enter the image.
3. The reference client pins the release above.
4. Inputs normalizing to only special/padding tokens are rejected.
5. Cosine is clamped to [-1,1].
6. Noncanonical health lines are rejected consistently.
7. Readiness becomes 503 for inference stuck beyond the bounded request deadline.
8. Admission meters executed padded model work, per owner across projects, with a finite burst and refill. The model uses its two allocated CPU threads. This bounds abuse; it does not promise unlimited multi-tenant capacity.
9. Native packages use immutable Debian snapshot file URLs with unchanged SHA-256 and length verification.
10. Invalid or missing admission signatures fail before body buffering.
11. The actual private-runner source at c3ae7e469c5aa72cbea77ef25cb10c055f9973d6 is included, rather than the older reference revision. Its authenticated build receipt names run 39072928811. All published OCI layers can be checked against the registry's digest graph. The expired real issuer signature in semantic-search-admission-key.json verifies with the image's public key. Base-image package/CVE assessment is still an independent review responsibility; an operator statement is not an audit.

Focused validation reused the existing model and environment: five focused cases for owner/nonce limits, health headroom, cleanup, padded tensor costs and deduplication; prior budget and protocol regression evidence is retained. Previously completed model/protocol and provider checks remain evidence for unchanged behavior. No unrelated full suite was repeated. A new immutable image and exact-source review are required because the runtime source changed; all prior paid reviews remain retained.
