// Only explicit authority failures are terminal. Transport, storage and lease
// failures retain the original intent and must not be treated as revocation.
export const authorityDenied = error => [
  'signal_not_enabled', 'signal_admission_changed', 'signal_scope_not_reviewed', 'signal_review_context_changed',
  'public_result_unavailable', 'result_source_changed', 'signal_source_changed', 'signal_api_revoked',
  'chain_public_not_enabled', 'chain_admission_changed', 'chain_scope_not_reviewed', 'project_unavailable', 'project_admission_paused',
  'scope_denied', 'unauthenticated', 'mandate_revoked', 'invalid_mandate',
  'sponsor_not_enabled', 'chain_not_enabled', 'executor_not_enabled', 'source_not_published',
  'transaction_not_authorized', 'proposal_stale', 'project_suspended',
  'intake_admission_changed', 'intake_review_not_admitted', 'intake_projects_not_admitted',
  'project_binding_changed', 'approval_expired', 'wallets_not_enabled',
  'wallet_profile_changed', 'payment_not_pending', 'payment_expired', 'session_expired', 'session_stale', 'session_retired', 'session_payment_denied',
  'vaults_not_enabled', 'vault_profile_changed', 'policy_not_verified', 'vault_deployment_expired', 'vault_review_context_changed',
  'dependency_evidence_mismatch', 'evidence_block_changed', 'dependency_code_changed', 'dependency_code_missing',
  'dependency_delegation_unsupported', 'dependency_indirection_unsupported', 'dependency_proxy_unsupported', 'service_not_available'
].includes(error?.code);
