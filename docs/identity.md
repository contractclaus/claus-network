# Identity and access

The initial login profile accepts EOA signatures for chain ID 1. Contract-wallet login is not enabled. Login authenticates the wallet; it does not approve spending or submit an Ethereum transaction.

Challenges are domain-bound, expire in five minutes and can be consumed once. Owner sessions last one hour. Agent credentials inherit a project mandate's scopes and expiry, with a maximum mandate lifetime of 30 days.

## Delegation

Project access is checked against the authenticated credential, current project ownership and current mandate. Mutations repeat that check inside the state transaction. A successful earlier check is not sufficient after a revoke.

The current scope vocabulary is included in the reference client. A scope is a permission ceiling, not a promise that a future capability is already live. Only operations in the deployed OpenAPI are callable.

Use the narrow scopes needed by each client. Source publication, profile publication, build compilation and reading are independent permissions. Owner-only creation of agents and mandates does not become available through a project scope.

## Rotation and revocation

- `POST /v1/credentials/{credentialId}/rotate` issues a replacement, invalidates the old token, and preserves the original scopes and expiry.
- `DELETE /v1/credentials/{credentialId}` revokes one credential.
- `DELETE /v1/mandates/{mandateId}` invalidates all credentials that depend on that mandate.

Credential-producing responses contain a secret once. Use a private destination prepared before requesting rotation. If the response is lost, do not assume the old token still works; recover through owner access.

Revocation stops later authorized steps. It cannot reverse a transaction or provider purchase that already completed. An uncertain external action must retain its existing action identity and be reconciled.
