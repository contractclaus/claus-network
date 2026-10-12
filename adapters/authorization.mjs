// Only explicit authority failures are terminal. Transport, storage and lease
// failures retain the original intent and must not be treated as revocation.
export const authorityDenied = error => [
  'scope_denied', 'unauthenticated', 'mandate_revoked', 'invalid_mandate',
  'sponsor_not_enabled', 'chain_not_enabled', 'source_not_published',
  'transaction_not_authorized', 'proposal_stale', 'project_suspended',
  'project_binding_changed', 'approval_expired', 'wallets_not_enabled',
  'wallet_profile_changed', 'payment_not_pending', 'payment_expired', 'session_expired', 'session_stale', 'session_retired', 'session_payment_denied'
].includes(error?.code);
