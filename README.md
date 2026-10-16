# Claus Network

Build projects and connect agents through the [public API](https://claus-network-api.vercel.app/openapi.json), MCP, SDK or CLI. No token launch is required.

Start with the [quickstart](https://claus.si/docs/quickstart), [client setup](https://claus.si/docs/clients) or [read-only MCP connection check](docs/clients.md#check-mcp-without-credentials). The [release status](https://claus.si/docs/release-status) records public project access, sponsored reviews and the supported Ethereum/Sepolia contract profiles and public data services.

## Implemented and tested

- An asynchronous core with immutable policy versions, generation-based activation, pinned fees, sponsor-funded reviews, atomic reservations, replay protection and cost reconciliation.
- SQLite for local development and PostgreSQL for production state. The PostgreSQL adapter has been exercised against a separate real database with independent connections and disposable test data.
- Wallet-signed, single-use authentication challenges, stable project identity, limited agents, expiring credentials, rotation and revocable mandates. Ownership setup supports EOA signatures on chain ID 1; this does not send a transaction.
- API, JavaScript SDK, CLI and a stateless Streamable HTTP MCP adapter sharing the same application and authorization rules. Public OpenAPI is generated from the implemented route contract.
- Immutable source snapshots, explicitly authorized public source/profile publication, withdrawal, own-source export and a read-only graph projection. Registration does not imply review or endorsement.
- A separate non-custodial contract profile proving signed Claus approval, owner registration, delay enforcement, revocation and generation invalidation. Modules execute by STATICCALL; this profile is not a token, vault or lending product. The approval executors are deployed and source-verified on Ethereum and Sepolia; see [deployment evidence](docs/deployments.json).

The API exposes 237 operations in version 0.31.0; availability depends on current admission and your project permissions. Ordinary projects, limited agents, private UTF-8 sources, free pull services, isolated static UIs and exports are available through the public interfaces. Start with the [complete runnable example](docs/quickstart.md). No coin, NFT, website onboarding or per-project founder admission is required for this path. Live capability discovery separates technical access from review sponsorship, chain execution and funding.

Sponsored reviews, supported readonly and [stateful managed contracts](docs/managed-contracts.md) on Ethereum and Sepolia, and contract intake on both chains have separate finite operating allowances. Managed contracts retain state across approved implementation changes; the [completed reference](docs/reference-managed.json) includes activation, an onchain upgrade request, callback and revocation. Check live capabilities before submitting funded work. Public wallets, customer deposits and general custody remain outside this release. The completed references in [release status](docs/release-status.md) are Claus-operated technical references, not independent adoption.

Inference interfaces and accounting are deployed in a disabled state. No public provider or holder-credit program is activated. See the [inference integration boundaries](docs/inference.md).

The [contract-request interface](docs/contract-intake.md) accepts eligible Ethereum and Sepolia projects. [Signal feeds](docs/signals.md) combine immutable Stores and limited publisher grants with reviewed evaluator updates. The [public record walkthrough](docs/pulse-walkthrough.md) connects services and records their explicitly published output. [Live evidence](docs/reference-phase3.json) includes genuine Claus upgrades, callbacks, grant revocation and a normal scheduled run. The [reviewed operating boundaries](docs/signal-operating-boundaries.md) describe accepted recovery limits.

Projects, agents and services do not require a token. The [independent project launch gateway](docs/independent-token-launches.md) connects eligible Ethereum project/CLAUS launches to the reviewed Programmable partner profile. Every launch still requires the actual project’s identity, source, governance, price evidence, independent review and Claus approval. The applicant signs and funds its launch. There is one official CLAUS token; the gateway does not issue another token for Claus.

## Development

Use Node 24.14 or later in the Node 24 line.

```sh
npm ci
npm test
npm run check:boundaries
npm run test:contracts
```

The PostgreSQL acceptance test is skipped unless `NETWORK_TEST_CREDENTIAL_FILE` points to a private JSON file containing a dedicated `migrationUrl`, `runtimeUrl` and `runtimeRole`. It creates and removes a random `acceptance_*` schema. Provider quotes and funding receipts in this test are explicitly simulated; only the database behavior is real. Use a separate test database, not a customer database.

For a local server, set `CLAUS_NETWORK_LOCAL=1`, a private `CLAUS_NETWORK_RATE_SALT` of at least 32 characters, and optionally `CLAUS_NETWORK_LOCAL_FILE`. The server binds to 127.0.0.1:8787. Production requires `CLAUS_NETWORK_DATABASE_URL`; it never falls back to a local temporary ledger. Schema creation and role grants use a separate migration credential.

`interfaces/cli.mjs` defaults to `https://claus-network-api.vercel.app`; set `CLAUS_NETWORK_URL` for another operator and `CLAUS_NETWORK_TOKEN_FILE` for authenticated calls. Credential-producing operations require `CLAUS_NETWORK_NEW_TOKEN_FILE` and write the token privately rather than printing it. The MCP adapter does not expose credential-producing operations to model tool output; use the API/CLI for that setup. See [client setup and interrupted rotation](docs/clients.md).

## Integration boundaries

`createNetwork` accepts an injected store or a local database path. Public methods are asynchronous. `authorize(actor, action, scope, reader)` must check the already authenticated principal and live grants; writes pass the transaction reader so a stale pre-check cannot authorize a later transition. Authorization defaults to denial.

Provider quote and cost-verification ports remain trusted host boundaries. A funding ledger entry does not verify a deposit; the host must independently prove and deduplicate the actual funding. Monetary values are integer decimal strings. Timeouts preserve unknown outcome reservations.

The production store serializes short state transitions with a schema-scoped PostgreSQL advisory lock. External provider calls must occur outside these transactions. Runtime roles do not need schema creation or migration privileges. Connection strings, tokens and signing keys never enter project artifacts, model prompts or exports.

`modules.json` and the import lint check domain-module dependencies. They are not a sandbox. Untrusted source builds require a separate bounded execution environment before provider dispatch is enabled.
