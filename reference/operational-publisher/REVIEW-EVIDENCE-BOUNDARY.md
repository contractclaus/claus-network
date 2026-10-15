# Independent publisher review evidence

The operational and surface publishers now verify a review against the separate payer's original admitted request and completed answer. A Native database copy is no longer sufficient evidence of approval.

The payer records a canonical request digest and an exact instructions digest when it admits a new paid request. Its evidence endpoint requires a distinct publisher-only credential. Native does not receive that credential. Reading evidence neither purchases a request nor modifies accounting.

For existing requests, the endpoint accepts up to three candidate serializations. The original maximum and serialized request must match the payer's saved request hash. The endpoint reconstructs a digest without replacing the original request, result, reservation or charge. Unsupported historical formats remain unavailable rather than silently becoming fresh requests.

The fixed publisher checks the original ID, canonical input, pinned review instructions, maximum amount, selected model and complete provider output. It then binds the reviewed files and changes to the exact release and current authorized scope revision. The provider's answer is used directly. Native-written completion flags, verdicts and recovery objects cannot substitute for it.

The existing provider-create journal, revocation checks and unknown-outcome holds remain in force. This boundary does not give Native unrestricted source, SQL, signing or credentials access. Native still controls work and other records; those remaining boundaries require separate work.

R26 preserves a completed original surface review through the new evidence path. A different historical operational review uses older instructions and is intentionally ineligible as a new current-scope approval. No paid review was repeated.

## App transaction correction

PostgreSQL applies update row policies to `SELECT ... FOR SHARE`. After R25 made global controls read-only, an application transaction could incorrectly see an enabled capability as missing and refuse a task. API13 takes the shared global network advisory lock before the app lock and reads protected controls without a row update lock. The control writer still takes the exclusive global lock. Other network rows retain their existing row locks.

The actual runtime role reproduced the old failure and verified the correction, control-writer exclusion, denied protected updates and rolled-back app writes. The real status-reporter job subsequently opened through the public API. This is a live application correction, not a completed external paid-work demonstration.
