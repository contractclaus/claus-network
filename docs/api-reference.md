# API reference

This reference covers API 0.6. Check the [release status](release-status.md) for activation of individual capabilities and the [live OpenAPI document](https://claus-network-api.vercel.app/openapi.json) for the deployed interface. The [packaged schema](openapi.json) is generated from this source. JSON request fields are strict; unknown fields and duplicate path/query/body bindings are rejected.

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
| `service_register` | POST | `/v1/projects/{projectId}/services` | Bearer credential |
| `service_get` | GET | `/v1/projects/{projectId}/services/{serviceId}` | Bearer credential |
| `service_publish` | PUT | `/v1/projects/{projectId}/services/{serviceId}/publication` | Bearer credential |
| `service_suspend` | POST | `/v1/projects/{projectId}/services/{serviceId}/suspend` | Bearer credential |
| `service_catalog` | GET | `/v1/public/services` | Public |
| `service_quote` | POST | `/v1/projects/{projectId}/service-quotes` | Bearer credential |
| `service_accept` | POST | `/v1/projects/{projectId}/service-orders` | Bearer credential |
| `service_order` | GET | `/v1/projects/{projectId}/service-orders/{orderId}` | Bearer credential |
| `service_authorize` | POST | `/v1/projects/{projectId}/service-orders/{orderId}/authorization` | Bearer credential |
| `service_cancel` | DELETE | `/v1/projects/{projectId}/service-orders/{orderId}` | Bearer credential |
| `service_result` | GET | `/v1/projects/{projectId}/service-orders/{orderId}/result` | Bearer credential |
| `service_accept_result` | POST | `/v1/projects/{projectId}/service-orders/{orderId}/acceptance` | Bearer credential |
| `provider_orders` | GET | `/v1/projects/{projectId}/service-assignments` | Bearer credential |
| `provider_claim` | POST | `/v1/projects/{projectId}/service-assignments/{orderId}/claim` | Bearer credential |
| `provider_deliver` | PUT | `/v1/projects/{projectId}/service-assignments/{orderId}/delivery` | Bearer credential |
| `wallet_create` | POST | `/v1/projects/{projectId}/wallet` | Bearer credential |
| `wallet_get` | GET | `/v1/projects/{projectId}/wallet` | Bearer credential |
| `wallet_action` | GET | `/v1/projects/{projectId}/wallet/actions/{actionId}` | Bearer credential |
| `wallet_session_prepare` | POST | `/v1/projects/{projectId}/wallet/sessions/prepare` | Bearer credential |
| `wallet_session_submit` | POST | `/v1/projects/{projectId}/wallet/sessions/{sessionId}/submit` | Bearer credential |
| `wallet_session_revoke` | POST | `/v1/projects/{projectId}/wallet/sessions/{sessionId}/revoke-transaction` | Bearer credential |
| `wallet_payment_prepare` | POST | `/v1/projects/{projectId}/wallet/payments/prepare` | Bearer credential |
| `wallet_payment_submit` | POST | `/v1/projects/{projectId}/wallet/payments/{paymentId}/submit` | Bearer credential |
| `vault_create` | POST | `/v1/projects/{projectId}/vault` | Bearer credential |
| `vault_get` | GET | `/v1/projects/{projectId}/vault` | Bearer credential |
| `vault_transaction` | POST | `/v1/projects/{projectId}/vault/transaction` | Bearer credential |
| `vault_balance` | GET | `/v1/projects/{projectId}/vault/balance` | Bearer credential |
| `release_create` | POST | `/v1/projects/{projectId}/releases` | Bearer credential |
| `release_get` | GET | `/v1/projects/{projectId}/releases/{releaseId}` | Bearer credential |
| `release_publish` | PUT | `/v1/projects/{projectId}/releases/{releaseId}/publication` | Bearer credential |
| `public_release` | GET | `/v1/public/releases/{releaseId}` | Public |
| `source_publish` | PUT | `/v1/projects/{projectId}/sources/{snapshotId}/publication` | Bearer credential |
| `project_publish` | PUT | `/v1/projects/{projectId}/publication` | Bearer credential |
| `project_export` | POST | `/v1/projects/{projectId}/exports` | Bearer credential |
| `public_project` | GET | `/v1/public/projects/{slug}` | Public |
| `public_source` | GET | `/v1/public/sources/{sourceId}` | Public |
| `network_graph` | GET | `/v1/public/graph` | Public |

Errors contain `error` and `retryable`. Typical statuses: 400 invalid input, 401 missing/expired credential, 403 denied scope/origin, 404 unavailable resource, 409 revision/idempotency or active-work conflict, 429 admission capacity, and 503 temporary service failure. Do not infer success from a network timeout.
