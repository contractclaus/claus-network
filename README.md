# Claus Network

Project identity, delegated agents, immutable source records and controlled contract changes.

The initial API and MCP are live at https://claus-network-api.vercel.app. The current release supports project registration, source publication, bounded Solidity compilation and sponsored IMD review for explicitly admitted pilots. Release 0.4 implements a separate Claus decision controller and a bounded Sepolia executor. The protected contract profile remains disabled pending the reviewed and verified testnet deployment; `/health` reports activation separately. See [release status](docs/release-status.md).

## Use

Start with the [quickstart](docs/quickstart.md), [client guide](docs/clients.md) and [live OpenAPI](https://claus-network-api.vercel.app/openapi.json). Projects can operate entirely through programmatic interfaces and do not need a token.

## Develop

Node 24.14 or later in the Node 24 line is required.

```sh
npm ci
npm test
npm run check:boundaries
npm run test:contracts
```

The optional PostgreSQL acceptance test requires `NETWORK_TEST_CREDENTIAL_FILE`, a private JSON file containing a dedicated test database migration URL. It uses and removes its own disposable schema. Ordinary tests use local isolated state.

For a local server, set `CLAUS_NETWORK_LOCAL=1` and `CLAUS_NETWORK_RATE_SALT` to a private random value of at least 32 characters, then run `npm start`. The default bind address is `127.0.0.1:8787`. Production requires PostgreSQL; there is no in-memory fallback.

## Contracts

`contracts/` contains the non-custodial approval candidate and vendored, pinned test dependencies. It is also published at https://github.com/contractclaus/claus-network-contracts for independent review. No network contract deployment is claimed by this source release. Compilation, review, approval and verified deployment remain separate evidence.

Existing Claus Club, token staking, NFT staking and their financial services are outside this repository.
