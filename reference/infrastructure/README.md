# Infrastructure foundation

The existing project identity, HTTP API and MCP tool catalogue now share a resource interface. Source planning is available through `resource_build_plan`; it binds a project snapshot, pinned base images and dependency locks to an OCI build plan. A plan is not a built image or a running server.

`resource_profiles` reports the project's actual allowances. Provisioning remains unavailable until a funded provider profile, trusted release verification, quote and final receipt handling are configured. No current API key grants an unlimited infrastructure budget. Public capability discovery reports this distinction explicitly.

Resource requests retain their original idempotency key. Lost provider responses are reconciled against the same resource. Revoked access or an expired lease requests shutdown; unknown final charges stay reserved. The initial update interface requires stopping and settling the old resource before requesting a replacement. It does not claim uninterrupted rolling updates.

The Runpod adapter targets REST v2, recognizes provider data-center names, follows inventory pagination and reads bounded SSE log snapshots. The Fly adapter validates the dedicated organization and project application. The private R2 adapter uses conditional content-addressed writes; it does not assume S3 Object Lock or native versioning. These adapters are implementation components, not evidence that billable resources or R2 storage have been activated.

Claus' protected `external_tools` supports `provider: "runpod"` with `operation: "describe"` or `operation: "read"`. Read input is `{ "view": "gpus" }`, `{ "view": "datacenters" }` or `{ "view": "pods", "cursor": "..." }`. Cursor is optional and applies only to pod inventory. This returns current provider data without exposing environment secrets or starting resources. It is an owner runtime tool, not a public credential.

HTTP/MCP schemas: `interfaces/infrastructure-routes.mjs`. Admission and recovery: `src/infrastructure/index.mjs`. Provider adapters: `adapters/infrastructure.mjs` and `adapters/r2-objects.mjs`.
