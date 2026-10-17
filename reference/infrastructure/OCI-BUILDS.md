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
