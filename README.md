# Claus Network

Claus Network implementation. The initial project/source API and MCP are live at https://claus-network-api.vercel.app; OpenAPI is at `/openapi.json`. The [release status](docs/release-status.md) distinguishes deployed features from work in progress. This repository publishes the programmatic interfaces, worker implementations and reference contracts.

## Implemented and tested

- An asynchronous core with immutable policy versions, generation-based activation, pinned fees, sponsor-funded reviews, atomic reservations, replay protection and cost reconciliation.
- SQLite for local development and PostgreSQL for production state. The PostgreSQL adapter has been exercised against a separate real database with independent connections and disposable test data.
- Wallet-signed, single-use authentication challenges, stable project identity, limited agents, expiring credentials, rotation and revocable mandates. Ownership setup supports EOA signatures on chain ID 1; this does not send a transaction.
- API, JavaScript SDK, CLI and a stateless Streamable HTTP MCP adapter sharing the same application and authorization rules. Public OpenAPI is generated from the implemented route contract.
- Immutable source snapshots, explicitly authorized public source/profile publication, withdrawal, own-source export and a read-only graph projection. Registration does not imply review or endorsement.
- A separate non-custodial contract profile proving signed Claus approval, owner registration, delay enforcement, revocation and generation invalidation. Modules execute by STATICCALL; this profile is not a token, vault or lending product. The approval executor is deployed and source-verified on Sepolia; see [deployment evidence](docs/deployments.json).

API 0.9.3 exposes 89 operations. Sponsored IMD reviews, the automatic Home map, protected Sepolia workers, service registration, reviewed project wallets and isolated static publication are live for admitted pilots. The Claus-operated Balance Explorer has paid two services, changed its agent, published their result and retired both payment sessions. Claus approved the corrected protected-change proposal; onchain execution is finalized, exact readback passed and the original project evidence is published. Signed transfers are active and the hosted reference continued work on a separately configured Claus-operated instance. The native-vault profile is enabled for one owner-operated Sepolia reference; its end-to-end acceptance is still in progress. Public documentation is available in this repository; optional GitBook publication requires account access. See [release status](docs/release-status.md). Existing Club, staking, NFT and payment services remain separate.

Inference interfaces and accounting are deployed in a disabled state. No public provider or holder-credit program is activated. See the [inference integration boundaries](docs/inference.md).

The 0.9.3 source also includes a disabled [contract-request interface](docs/contract-intake.md), its scanner and delivery coordinator, and read-only Base settlement verification. These are prepared components, not a public onchain inbox, token launch service or inference provider.

## Development

Use Node 24.14 or later in the Node 24 line.

```sh
npm ci
npm test
npm run check:boundaries
npm run test:contracts
```

The PostgreSQL acceptance test is skipped unless `NETWORK_TEST_CREDENTIAL_FILE` points to a private JSON file containing a dedicated `migrationUrl`. It creates and removes a random `acceptance_*` schema. Provider quotes and funding receipts in this test are explicitly simulated; only the database behavior is real. Use a separate test database, not a customer database.

For a local server, set `CLAUS_NETWORK_LOCAL=1`, a private `CLAUS_NETWORK_RATE_SALT` of at least 32 characters, and optionally `CLAUS_NETWORK_LOCAL_FILE`. The server binds to 127.0.0.1:8787. Production requires `CLAUS_NETWORK_DATABASE_URL`; it never falls back to a local temporary ledger. Schema creation and role grants use a separate migration credential.

`interfaces/cli.mjs` uses `CLAUS_NETWORK_URL` and an optional `CLAUS_NETWORK_TOKEN_FILE`. Credential-producing operations require `CLAUS_NETWORK_NEW_TOKEN_FILE` and write the token privately rather than printing it. The MCP adapter does not expose credential-producing operations to model tool output; use the API/CLI for that setup.

## Integration boundaries

`createNetwork` accepts an injected store or a local database path. Public methods are asynchronous. `authorize(actor, action, scope, reader)` must check the already authenticated principal and live grants; writes pass the transaction reader so a stale pre-check cannot authorize a later transition. Authorization defaults to denial.

Provider quote and cost-verification ports remain trusted host boundaries. A funding ledger entry does not verify a deposit; the host must independently prove and deduplicate the actual funding. Monetary values are integer decimal strings. Timeouts preserve unknown outcome reservations.

The production store serializes short state transitions with a schema-scoped PostgreSQL advisory lock. External provider calls must occur outside these transactions. Runtime roles do not need schema creation or migration privileges. Connection strings, tokens and signing keys never enter project artifacts, model prompts or exports.

`modules.json` and the import lint check domain-module dependencies. They are not a sandbox. Untrusted source builds require a separate bounded execution environment before provider dispatch is enabled.
