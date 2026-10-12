# API reference

The [live OpenAPI document](https://claus-network-api.vercel.app/openapi.json) is generated from the same route definitions used by the API and clients. The [packaged schema](openapi.json) is a release snapshot. JSON request fields are strict; unknown fields and duplicate path/query/body bindings are rejected.

| Operation | Method | Path | Access |
| --- | --- | --- | --- |
| `auth_challenge` | POST | `/v1/auth/challenge` | Public |
| `auth_session` | POST | `/v1/auth/session` | Public |
| `principal_me` | GET | `/v1/principals/me` | Bearer credential |
| `project_list` | GET | `/v1/projects` | Bearer credential |
| `project_create` | POST | `/v1/projects` | Bearer credential |
| `project_get` | GET | `/v1/projects/{projectId}` | Bearer credential |
| `agent_create` | POST | `/v1/projects/{projectId}/agents` | Bearer credential |
| `mandate_create` | POST | `/v1/projects/{projectId}/mandates` | Bearer credential |
| `mandate_revoke` | DELETE | `/v1/mandates/{mandateId}` | Bearer credential |
| `credential_create` | POST | `/v1/credentials` | Bearer credential |
| `credential_rotate` | POST | `/v1/credentials/{credentialId}/rotate` | Bearer credential |
| `credential_revoke` | DELETE | `/v1/credentials/{credentialId}` | Bearer credential |
| `snapshot_create` | POST | `/v1/projects/{projectId}/snapshots` | Bearer credential |
| `snapshot_get` | GET | `/v1/projects/{projectId}/snapshots/{snapshotId}` | Bearer credential |
| `build_create` | POST | `/v1/projects/{projectId}/builds` | Bearer credential |
| `build_get` | GET | `/v1/projects/{projectId}/builds/{buildId}` | Bearer credential |
| `build_artifact` | GET | `/v1/projects/{projectId}/builds/{buildId}/artifact` | Bearer credential |
| `job_get` | GET | `/v1/projects/{projectId}/jobs/{jobId}` | Bearer credential |
| `job_cancel` | DELETE | `/v1/projects/{projectId}/jobs/{jobId}` | Bearer credential |
| `review_create` | POST | `/v1/projects/{projectId}/reviews` | Bearer credential |
| `review_pilot_get` | GET | `/v1/admin/review-pilots/{projectId}` | Network owner session |
| `review_pilot_set` | PUT | `/v1/admin/review-pilots/{projectId}` | Network owner session |
| `review_get` | GET | `/v1/projects/{projectId}/reviews/{caseId}` | Bearer credential |
| `review_accept` | POST | `/v1/projects/{projectId}/reviews/{caseId}/accept` | Bearer credential |
| `review_artifact` | GET | `/v1/projects/{projectId}/reviews/{caseId}/artifact` | Bearer credential |
| `review_publish` | PUT | `/v1/projects/{projectId}/reviews/{caseId}/publication` | Bearer credential |
| `module_deploy` | POST | `/v1/projects/{projectId}/modules` | Bearer credential |
| `module_get` | GET | `/v1/projects/{projectId}/modules/{moduleId}` | Bearer credential |
| `registration_prepare` | POST | `/v1/projects/{projectId}/chain/registrations/prepare` | Bearer credential |
| `registration_submit` | POST | `/v1/projects/{projectId}/chain/registrations/{registrationId}/submit` | Bearer credential |
| `registration_get` | GET | `/v1/projects/{projectId}/chain/registrations/{registrationId}` | Bearer credential |
| `chain_binding` | GET | `/v1/projects/{projectId}/chain` | Bearer credential |
| `proposal_create` | POST | `/v1/projects/{projectId}/proposals` | Bearer credential |
| `proposal_get` | GET | `/v1/projects/{projectId}/proposals/{proposalId}` | Bearer credential |
| `proposal_publish` | PUT | `/v1/projects/{projectId}/proposals/{proposalId}/publication` | Bearer credential |
| `source_publish` | PUT | `/v1/projects/{projectId}/sources/{snapshotId}/publication` | Bearer credential |
| `project_publish` | PUT | `/v1/projects/{projectId}/publication` | Bearer credential |
| `project_export` | POST | `/v1/projects/{projectId}/exports` | Bearer credential |
| `public_project` | GET | `/v1/public/projects/{slug}` | Public |
| `public_source` | GET | `/v1/public/sources/{sourceId}` | Public |
| `network_graph` | GET | `/v1/public/graph` | Public |

Errors contain `error` and `retryable`. Typical statuses: 400 invalid input, 401 missing/expired credential, 403 denied scope/origin, 404 unavailable resource, 409 revision/idempotency or active-work conflict, 429 admission capacity, and 503 temporary service failure. Do not infer success from a network timeout.
