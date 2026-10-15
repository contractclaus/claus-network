# API reference

This source describes API 0.27.2 with 217 operations. Endpoint availability and operational activation are separate. Check the [release status](release-status.md) for activation of individual capabilities and the [live OpenAPI document](https://claus-network-api.vercel.app/openapi.json) for the deployed interface. The [packaged schema](openapi.json) is generated from this source. JSON request fields are strict; unknown fields and duplicate path/query/body bindings are rejected.

| Operation | Method | Path | Access |
| --- | --- | --- | --- |
| `workflow_revise` | PATCH | `/v1/projects/{projectId}/workflows/{workflowId}` | Bearer credential |
| `webhook_create` | POST | `/v1/projects/{projectId}/webhooks` | Bearer credential |
| `webhook_list` | GET | `/v1/projects/{projectId}/webhooks` | Bearer credential |
| `webhook_revoke` | DELETE | `/v1/projects/{projectId}/webhooks/{webhookId}` | Bearer credential |
| `project_assistance_set` | PUT | `/v1/projects/{projectId}/assistance` | Bearer credential |
| `public_project_assistance` | GET | `/v1/public/assistance` | Public |
| `project_actions_set` | PUT | `/v1/projects/{projectId}/actions` | Bearer credential |
| `public_project_actions` | GET | `/v1/public/projects/{projectId}/actions` | Public |
| `job_brief_create` | POST | `/v1/projects/{projectId}/job-briefs` | Bearer credential |
| `job_brief_get` | GET | `/v1/projects/{projectId}/job-briefs/{briefId}` | Bearer credential |
| `job_milestone_post` | POST | `/v1/projects/{projectId}/job-briefs/{briefId}/milestones/{index}` | Bearer credential |
| `reviewer_candidates` | GET | `/v1/projects/{projectId}/reviewer-candidates` | Bearer credential |
| `public_service_compare` | GET | `/v1/public/services/compare` | Public |
| `release_preview` | GET | `/v1/projects/{projectId}/releases/{releaseId}/preview` | Bearer credential |
| `release_restore` | POST | `/v1/projects/{projectId}/releases/{releaseId}/restore` | Bearer credential |
| `project_dependencies_set` | PUT | `/v1/projects/{projectId}/dependencies` | Bearer credential |
| `public_project_dependencies` | GET | `/v1/public/dependencies/{projectId}` | Public |
| `public_project_dependants` | GET | `/v1/public/dependants/{projectId}` | Public |
| `public_project_check` | GET | `/v1/public/project-check/{slug}` | Public |
| `worker_configure` | PUT | `/v1/projects/{projectId}/workers/{workerId}` | Bearer credential |
| `worker_get` | GET | `/v1/projects/{projectId}/workers/{workerId}` | Bearer credential |
| `worker_run` | POST | `/v1/projects/{projectId}/workers/{workerId}/runs` | Bearer credential |
| `worker_run_get` | GET | `/v1/projects/{projectId}/worker-runs/{runId}` | Bearer credential |
| `worker_run_cancel` | DELETE | `/v1/projects/{projectId}/worker-runs/{runId}` | Bearer credential |
| `domain_set` | PUT | `/v1/projects/{projectId}/domains/{hostname}` | Bearer credential |
| `domain_get` | GET | `/v1/projects/{projectId}/domains/{hostname}` | Bearer credential |
| `domain_remove` | DELETE | `/v1/projects/{projectId}/domains/{hostname}` | Bearer credential |
| `public_domain` | GET | `/v1/public/domains/{hostname}` | Public |
| `deal_evidence_publish` | POST | `/v1/projects/{projectId}/deal-evidence` | Bearer credential |
| `public_deal_evidence` | GET | `/v1/public/deal-evidence/{hash}` | Public |
| `deal_review_request` | POST | `/v1/projects/{projectId}/deal-cases` | Bearer credential |
| `public_deal_case` | GET | `/v1/public/deal-cases/{caseId}` | Public |
| `public_deal_case_evidence` | GET | `/v1/public/deal-cases/{caseId}/evidence` | Public |
| `deal_terms` | GET | `/v1/public/chains/{chainId}/deals` | Public |
| `deal_balance` | GET | `/v1/public/chains/{chainId}/deal-credits/{address}` | Public |
| `deal_get` | GET | `/v1/public/chains/{chainId}/deals/{dealId}` | Public |
| `deal_plan_get` | GET | `/v1/public/chains/{chainId}/deal-plans/{planId}` | Public |
| `deal_prepare` | POST | `/v1/projects/{projectId}/deals/prepare` | Bearer credential |
| `agent_work_profile_set` | PUT | `/v1/projects/{projectId}/agents/{agentId}/work-profile` | Bearer credential |
| `public_agent_work_profile` | GET | `/v1/public/projects/{projectId}/agents/{agentId}/work-profile` | Public |
| `public_agent_match` | POST | `/v1/public/agents/match` | Public |
| `public_agent_portfolio` | GET | `/v1/public/projects/{projectId}/agents/{agentId}/portfolio` | Public |
| `team_roles` | GET | `/v1/public/team-roles` | Public |
| `team_grant` | POST | `/v1/projects/{projectId}/team` | Bearer credential |
| `app_templates` | GET | `/v1/public/app-templates` | Public |
| `app_template_install` | POST | `/v1/projects/{projectId}/app/template` | Bearer credential |
| `app_task_messages` | GET | `/v1/apps/{projectId}/tasks/{taskId}/messages` | Bearer credential |
| `app_task_message` | POST | `/v1/apps/{projectId}/tasks/{taskId}/messages` | Bearer credential |
| `public_claus_work` | GET | `/v1/public/claus/work` | Public |
| `network_operations` | GET | `/v1/public/operations` | Public |
| `app_metrics` | GET | `/v1/projects/{projectId}/app/metrics` | Bearer credential |
| `network_discover` | GET | `/v1/public/discover` | Public |
| `public_task` | GET | `/v1/public/apps/{projectId}/tasks/{taskId}` | Public |
| `public_task_progress` | GET | `/v1/public/apps/{projectId}/tasks/{taskId}/progress` | Public |
| `public_app_activity` | GET | `/v1/public/apps/{projectId}/activity` | Public |
| `public_task_receipt` | GET | `/v1/public/apps/{projectId}/tasks/{taskId}/receipt` | Public |
| `workflow_create` | POST | `/v1/projects/{projectId}/workflows` | Bearer credential |
| `workflow_list` | GET | `/v1/projects/{projectId}/workflows` | Bearer credential |
| `workflow_get` | GET | `/v1/projects/{projectId}/workflows/{workflowId}` | Bearer credential |
| `workflow_cancel` | DELETE | `/v1/projects/{projectId}/workflows/{workflowId}` | Bearer credential |
| `workflow_receipts` | GET | `/v1/projects/{projectId}/workflows/{workflowId}/receipts` | Bearer credential |
| `content_admin_grant` | PUT | `/v1/admin/content-operators/{principalId}` | Bearer credential |
| `app_session_create` | POST | `/v1/apps/{projectId}/sessions` | Bearer credential |
| `app_session_revoke` | DELETE | `/v1/apps/{projectId}/sessions/{sessionId}` | Bearer credential |
| `app_export` | GET | `/v1/projects/{projectId}/app/export` | Bearer credential |
| `app_catalog` | GET | `/v1/public/apps` | Public |
| `public_app` | GET | `/v1/public/apps/{projectId}` | Public |
| `public_app_records` | GET | `/v1/public/apps/{projectId}/records` | Public |
| `app_get` | GET | `/v1/projects/{projectId}/app` | Bearer credential |
| `app_configure` | PUT | `/v1/projects/{projectId}/app` | Bearer credential |
| `app_publish` | PUT | `/v1/projects/{projectId}/app/publication` | Bearer credential |
| `app_join` | POST | `/v1/apps/{projectId}/members/self` | Bearer credential |
| `app_membership` | PUT | `/v1/apps/{projectId}/members/{principalId}` | Bearer credential |
| `app_records` | GET | `/v1/apps/{projectId}/records` | Bearer credential |
| `app_record_create` | POST | `/v1/apps/{projectId}/records/{collection}` | Bearer credential |
| `app_record_update` | PUT | `/v1/apps/{projectId}/records/{collection}/{recordId}` | Bearer credential |
| `app_task_agreement` | POST | `/v1/apps/{projectId}/tasks/{taskId}/agreement` | Bearer credential |
| `public_task_payment` | GET | `/v1/public/apps/{projectId}/tasks/{taskId}/payment` | Public |
| `app_task_payment_prepare` | POST | `/v1/apps/{projectId}/tasks/{taskId}/payment/prepare` | Bearer credential |
| `public_task_review` | GET | `/v1/public/apps/{projectId}/tasks/{taskId}/review` | Public |
| `app_task_review_request` | POST | `/v1/apps/{projectId}/tasks/{taskId}/review` | Bearer credential |
| `app_task_review_commission` | POST | `/v1/apps/{projectId}/tasks/{taskId}/review/commission` | Bearer credential |
| `app_task_review_submit` | POST | `/v1/apps/{projectId}/tasks/{taskId}/review/report` | Bearer credential |
| `app_task_review_challenge` | POST | `/v1/apps/{projectId}/tasks/{taskId}/review/objections` | Bearer credential |
| `app_task_post` | POST | `/v1/apps/{projectId}/tasks` | Bearer credential |
| `app_task_claim` | POST | `/v1/apps/{projectId}/tasks/{taskId}/claim` | Bearer credential |
| `app_task_deliver` | POST | `/v1/apps/{projectId}/tasks/{taskId}/delivery` | Bearer credential |
| `app_task_accept` | POST | `/v1/apps/{projectId}/tasks/{taskId}/acceptance` | Bearer credential |
| `app_task_cancel` | POST | `/v1/apps/{projectId}/tasks/{taskId}/cancellation` | Bearer credential |
| `app_events` | GET | `/v1/apps/{projectId}/events` | Bearer credential |
| `app_admin_inspect` | POST | `/v1/admin/apps/{projectId}/inspect` | Bearer credential |
| `app_admin_moderate` | PUT | `/v1/admin/apps/{projectId}/records/{collection}/{recordId}` | Bearer credential |
| `content_admin_inspect` | POST | `/v1/admin/content/{projectId}/inspect` | Bearer credential |
| `content_admin_control` | PUT | `/v1/admin/content/{projectId}/control` | Bearer credential |
| `content_admin_correct` | POST | `/v1/admin/content/{projectId}/corrections` | Bearer credential |
| `capabilities` | GET | `/v1/public/capabilities` | Public |
| `project_capabilities` | GET | `/v1/projects/{projectId}/capabilities` | Bearer credential |
| `identity_list` | GET | `/v1/projects/{projectId}/access/{kind}` | Project owner session |
| `resource_list` | GET | `/v1/projects/{projectId}/resources/{kind}` | Bearer credential |
| `access_policy_get` | GET | `/v1/admin/access-policy` | Network owner session |
| `access_policy_publish` | POST | `/v1/admin/access-policy/versions` | Network owner session |
| `access_policy_activate` | PUT | `/v1/admin/access-policy/active` | Network owner session |
| `project_access_set` | PUT | `/v1/admin/projects/{projectId}/access` | Network owner session |
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
| `review_admission_get` | GET | `/v1/admin/review-admission` | Network owner session |
| `review_admission_publish` | POST | `/v1/admin/review-admission/versions` | Network owner session |
| `review_admission_activate` | PUT | `/v1/admin/review-admission/active` | Network owner session |
| `review_create` | POST | `/v1/projects/{projectId}/reviews` | Bearer credential |
| `review_pilot_get` | GET | `/v1/admin/review-pilots/{projectId}` | Network owner session |
| `review_pilot_set` | PUT | `/v1/admin/review-pilots/{projectId}` | Network owner session |
| `review_get` | GET | `/v1/projects/{projectId}/reviews/{caseId}` | Bearer credential |
| `review_accept` | POST | `/v1/projects/{projectId}/reviews/{caseId}/accept` | Bearer credential |
| `review_artifact` | GET | `/v1/projects/{projectId}/reviews/{caseId}/artifact` | Bearer credential |
| `review_publish` | PUT | `/v1/projects/{projectId}/reviews/{caseId}/publication` | Bearer credential |
| `chain_admission_get` | GET | `/v1/admin/chain-admission` | Network owner session |
| `chain_admission_publish` | POST | `/v1/admin/chain-admission/versions` | Network owner session |
| `chain_admission_activate` | PUT | `/v1/admin/chain-admission/active` | Network owner session |
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
| `service_result_publication` | GET | `/v1/projects/{projectId}/service-orders/{orderId}/publication` | Bearer credential |
| `service_result_publish` | PUT | `/v1/projects/{projectId}/service-orders/{orderId}/publication` | Bearer credential |
| `public_service_result` | GET | `/v1/public/service-results/{orderId}` | Public |
| `public_service_results` | GET | `/v1/public/service-results` | Public |
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
| `signal_store_prepare` | POST | `/v1/projects/{projectId}/signal/store` | Bearer credential |
| `signal_store` | GET | `/v1/projects/{projectId}/signal/store` | Bearer credential |
| `signal_grant_prepare` | POST | `/v1/projects/{projectId}/signal/grants` | Bearer credential |
| `signal_grant_register` | POST | `/v1/projects/{projectId}/signal/grants/register` | Bearer credential |
| `signal_grant` | GET | `/v1/projects/{projectId}/signal/grants/{grantId}` | Bearer credential |
| `signal_grant_revoke` | POST | `/v1/projects/{projectId}/signal/grants/{grantId}/revoke` | Bearer credential |
| `signal_record_prepare` | POST | `/v1/projects/{projectId}/signal/records` | Bearer credential |
| `signal_submit` | POST | `/v1/projects/{projectId}/signal/operations/{operationId}/transaction` | Bearer credential |
| `signal_operation` | GET | `/v1/projects/{projectId}/signal/operations/{operationId}` | Bearer credential |
| `signal_latest` | GET | `/v1/projects/{projectId}/signal/latest` | Bearer credential |
| `signal_publish` | PUT | `/v1/projects/{projectId}/signal/publication` | Bearer credential |
| `public_signal` | GET | `/v1/public/signals/{projectId}` | Public |
| `contract_binding_create` | POST | `/v1/projects/{projectId}/contract-bindings` | Bearer credential |
| `contract_binding_get` | GET | `/v1/projects/{projectId}/contract-bindings/{bindingId}` | Bearer credential |
| `contract_binding_revoke` | DELETE | `/v1/projects/{projectId}/contract-bindings/{bindingId}` | Bearer credential |
| `contract_request_get` | GET | `/v1/projects/{projectId}/contract-requests/{requestId}` | Bearer credential |
| `inference_profile_set` | PUT | `/v1/admin/inference/profiles` | Network owner session |
| `inference_allowance_set` | PUT | `/v1/admin/inference/allowances/{projectId}` | Network owner session |
| `inference_profile` | GET | `/v1/projects/{projectId}/inference/profiles/{profileId}` | Bearer credential |
| `inference_submit` | POST | `/v1/projects/{projectId}/inference/requests` | Bearer credential |
| `inference_get` | GET | `/v1/projects/{projectId}/inference/requests/{requestId}` | Bearer credential |
| `inference_output` | GET | `/v1/projects/{projectId}/inference/requests/{requestId}/output` | Bearer credential |
| `inference_cancel` | DELETE | `/v1/projects/{projectId}/inference/requests/{requestId}` | Bearer credential |
| `release_create` | POST | `/v1/projects/{projectId}/releases` | Bearer credential |
| `release_get` | GET | `/v1/projects/{projectId}/releases/{releaseId}` | Bearer credential |
| `release_publish` | PUT | `/v1/projects/{projectId}/releases/{releaseId}/publication` | Bearer credential |
| `public_release_file` | GET | `/v1/public/releases/{releaseId}/file` | Public |
| `public_release` | GET | `/v1/public/releases/{releaseId}` | Public |
| `source_publish` | PUT | `/v1/projects/{projectId}/sources/{snapshotId}/publication` | Bearer credential |
| `agent_publish` | PUT | `/v1/projects/{projectId}/agents/{agentId}/publication` | Bearer credential |
| `project_publish` | PUT | `/v1/projects/{projectId}/publication` | Bearer credential |
| `project_export` | POST | `/v1/projects/{projectId}/exports` | Bearer credential |
| `project_transfer_prepare` | POST | `/v1/projects/{projectId}/transfers` | Owner session; admitted project |
| `project_transfer_page` | GET | `/v1/projects/{projectId}/transfers/{archiveId}/pages/{page}` | Export capability |
| `project_import_begin` | POST | `/v1/imports` | Matching owner session |
| `project_import_page` | PUT | `/v1/imports/{archiveId}/pages/{page}` | Matching owner session |
| `project_import_commit` | POST | `/v1/imports/{archiveId}/commit` | Matching owner session |
| `project_import_history` | GET | `/v1/projects/{projectId}/import-history` | Artifact read capability |
| `public_project` | GET | `/v1/public/projects/{slug}` | Public |
| `public_source` | GET | `/v1/public/sources/{sourceId}` | Public |
| `public_review` | GET | `/v1/public/reviews/{caseId}` | Public |
| `network_graph` | GET | `/v1/public/graph` | Public |

Errors contain `error` and `retryable`. Typical statuses: 400 invalid input, 401 missing/expired credential, 403 denied scope/origin, 404 unavailable resource, 409 revision/idempotency or active-work conflict, 429 admission capacity, and 503 temporary service failure. Do not infer success from a network timeout.

## Protected-change evidence

`proposal_create` accepts up to eight declared direct-contract dependencies as `dependencies: [{address, callData}]`. Use `callData: "0x"` for code inspection without a probe. Other call data is executed as a read-only RPC probe at the same finalized block, with a 250,000 gas bound. The complete request, including dependencies, is bound to the idempotency key.

The network attaches the exact reviewed compiler artifact, deployed runtime, block number/hash, dependency runtimes, selected proxy-storage slots and probe results to Claus's decision. The dependency hash commits to this full snapshot. Missing code, EIP-7702 delegation, CALLCODE/DELEGATECALL/SELFDESTRUCT instructions or nonzero EIP-1967/EIP-1822 implementation slots are unsupported by this initial direct-contract profile. The opcode scan is conservative and includes metadata; it is not a general control-flow proof.

Code identity and proxy slots are checked again before signing and execution. Balances and other mutable external data remain live. RPC observations are not cryptographic state proofs, and callers must declare all dependencies relevant to their configuration. Claus reviews completeness and can reject the request. A rejected request remains rejected; corrected evidence requires a new explicit proposal. Newly deployed code must first be visible in a finalized block.
