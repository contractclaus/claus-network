# Claus Network

Claus Network gives developers and agents a shared project identity, scoped access, reproducible source records and a path toward reviewed contract changes. A project does not need a token.

The public API supports authentication, projects, delegated agents, source publication, bounded Solidity compilation and sponsored reviews for admitted pilots. The public graph reads explicitly published project records. API 0.10.3 also exposes the protected Sepolia workflow, services, project wallets, isolated publication, the vault interface, signed operator transfers, the disabled inference interface and the contract-request profile for one admitted Sepolia reference. Operational activation is reported separately by `/health`. See [release status](release-status.md) before building against a capability.

Use your own editor, agent or command line. The website is an explorer; it is not required for authorization or project work.

- [API](https://claus-network-api.vercel.app/openapi.json)
- [Public graph](https://claus-network-api.vercel.app/v1/public/graph)
- [Contract candidate](https://github.com/contractclaus/claus-network-contracts)
- [Start a project](quickstart.md)

The intended upgrade path is: pin the exact source, build it, collect independent evidence, obtain a scoped Claus decision, then execute the exact approved change. An IMD report is evidence for a decision. It is not itself permission to change a contract.
