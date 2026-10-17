# Corrected semantic-search release

This source supersedes the declined image in review a0bc4afa-dea6-459d-9195-6bb8da722133. The prior report remains valid for its original bytes.

The model's immutable build, source and manifest are in semantic-search-release.json. The reference client now pins that same release. No runtime approval or hosting is inferred from a build.

## Review fixes

1. Canonical ASCII HTTP lines are enforced before body routing. Signature verification happens before anonymous body buffering; nonce consumption stays after the complete body.
2. The CPU reference adapter accepts an explicit host-owned CPU configuration, exposes the 8080 HTTPS proxy, checks health and preserves the original pod on repeated create/stop. The actual deployed broker and driver are in reference/runtime-custody, with exact source hashes and deployment identity. They were already the production path; no provider keys enter the image.
3. The reference client pins the release above.
4. Inputs normalizing to only special/padding tokens are rejected.
5. Cosine is clamped to [-1,1].
6. Noncanonical health lines are rejected consistently.
7. Readiness becomes 503 for inference stuck beyond the bounded request deadline.
8. Admission charges actual truncated model tokens, per owner across projects, with a finite burst and refill. The model uses its two allocated CPU threads. This bounds abuse; it does not promise unlimited multi-tenant capacity.
9. Native packages use immutable Debian snapshot file URLs with unchanged SHA-256 and length verification.
10. Invalid or missing admission signatures fail before body buffering.
11. The actual private-runner source at c3ae7e469c5aa72cbea77ef25cb10c055f9973d6 is included, rather than the older reference revision. Its authenticated build receipt names run 39068871012. All published OCI layers can be checked against the registry's digest graph. The expired real issuer signature in semantic-search-admission-key.json verifies with the image's public key. Base-image package/CVE assessment is still an independent review responsibility; an operator statement is not an audit.

Focused validation reused the existing model and environment: eight model/protocol cases plus the CPU lifecycle and existing GPU adoption/log checks. No unrelated full suite, new credentials, replacement of prior review jobs or duplicate image build was used.
