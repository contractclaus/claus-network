# OCI builds

Use the shared API or MCP operations to compile an already-public source snapshot into an OCI image archive. Read `capabilities.infrastructure.builds.enabled` first. Hosting activation and independent review are separate operations.

1. Create your immutable snapshot with a Dockerfile and dependency lockfiles. Base images require digest pins. Keep credentials out of source.
2. Explicitly publish that snapshot with `source_publish`. The standard runner is public: source, build logs and compiled artifacts can be read by others.
3. Submit `resource_build` with your `projectId`, `snapshotId`, `publishSource: true` and one stable `idempotencyKey`.
4. Read `resource_build_status` with the same build ID. Unknown means reconcile that ID, not submit another job. Queued work can be cancelled through the existing job cancellation operation.
5. `resource_build_artifact` returns the verified source/plan/image/archive hashes and the temporary GitHub artifact. Artifacts remain available for one day; retain your source and export needed outputs before expiry.

The initial standard runner exports images up to 32 MiB. Admission is two builds in a rolling 25-hour window across the lane, one per project in that window; uncertain outcomes retain capacity until reconciled. This does not create a paid provider, extend any money allocation, or grant wallet access. Larger/private production builds need their own funded runner profile. The isolated builder receives neither the GitHub publishing token nor wallet or provider credentials.

A failed or expired export does not replace any running service. Compilation is not deployment, review approval, independent adoption, or a claim of reproducibility for arbitrary network install steps.

Implementation references: [GitHub standard-runner billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [OCI exporter](https://docs.docker.com/build/exporters/oci-docker/).

## Recovery and availability

A temporary failure before dispatch leaves the original build `not_started`. The worker can resume that same ID only after an authenticated custody observation confirms it was not dispatched. Custody atomically records the original runner and permits one dispatch. An uncertain dispatch, including legacy records, is inspected and never blindly repeated.

`resource_build_status` includes `nextCheckAt` while waiting. Running builds are checked once a minute; unavailable or uncertain outcomes back off to at most one check per 15 minutes. Current configuration changes do not replace the original runner used for reconciliation. A revoked project cannot start a build or publish new output.

The complete serialized public source response must fit 3,200,000 bytes, including JSON escaping and the manifest. Oversized requests are rejected before a job consumes capacity. Capacity responses include `retryAt`; unresolved builds may continue to hold their existing slot after that time.

An expired artifact yields `oci_result_expired` when no receipt was collected, preserving the original run URL. A previously verified receipt remains readable with `artifactAvailability: "expired"`. Missing output after a completed run is reported separately; it does not cause a replacement build. Export needed images during the one-day retention period.

Contract compilation also resumes the original job after temporary R2 source-read failures. Integrity failures remain errors. No recovery path changes budgets, creates a replacement paid request, or deploys a running server.


## Durable private output

New completed builds are copied into the existing private R2 store before being marked complete. The original GitHub ZIP digest and inner `image.tar` digest and size are verified. Objects are separated by project and addressed by content hash. An interrupted copy resumes the same original build and checks the existing object before downloading again.

`resource_build_artifact` returns `storage.profile: "private-r2-oci-v1"`, `artifactAvailability: "available"` and an authorized `download` object. Its URL retrieves the original `image.tar` and expires after 60 seconds. Treat this URL as a short-lived bearer credential. Use the same API/MCP operation again for a fresh URL. The bucket remains private; source access, other projects and provider credentials are not included.

The one-day GitHub retention still applies to the provider's original artifact. It no longer expires a successfully preserved R2 copy. Legacy receipts without a saved copy keep their actual GitHub availability; missing original files are not recreated by silently rebuilding. There is no new retention promise for an absent or revoked storage service. Original run IDs, receipts and source hashes remain unchanged.

A saved OCI archive is not a registry image and does not authorize deployment. A durable image registry, reviewed runtime image admission, larger/private build support, paid provider activation and persistent application data remain separate work.
