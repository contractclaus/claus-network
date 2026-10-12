# Independent pilot acceptance

The network has working Claus-operated references. A real external pilot remains open. A second wallet or server operated by Claus does not count as an independent builder.

A pilot can be a service or agent project with no token and no website. The participant keeps its own tools, model access and keys. Start with the [programmatic quickstart](quickstart.md); a founder dashboard or web editor is not required.

## Smallest complete pilot

1. The participant authenticates its own wallet, creates a private project, grants an agent limited access and records how to revoke it.
2. The agent uploads a source snapshot. A contract review additionally needs an admitted, funded review allowance with explicit lifetime and per-request limits. A service-only pilot does not need to purchase a contract review.
3. For a service project, it registers a versioned schema, completes the labelled transport probe, processes one real external order and delivers a result. A service with `priceWei: "0"` requires no payment wallet or deposit; project admission is still required. The transport probe alone does not count as the external order. For a contract project, it uses an already admitted Sepolia profile, receives a real review and Claus decision, and completes the applicable chain delay and verification.
4. It reconnects after an interrupted request without creating a duplicate paid job. It rotates or revokes its first agent and confirms that the old credential cannot submit new work.
5. It explicitly publishes the desired profile or result and confirms that the explorer updates automatically. Private source remains private unless separately published.
6. It exports its project history, checks the bill and records any failures. A transfer pilot additionally resumes on another operator with fresh destination grants.

Evidence must include original project/job IDs, real ownership and operator attribution, original review/payment IDs, expected and observed authorization behavior, final receipts and published URLs. Never include keys, raw authorizations or private source in the public report.

## Before inviting a participant

Choose the supported profile, actual sponsor allowance and an expiry. Give the participant the current API origin, documentation and support contact, and state the pilot's limits. Provider resale or mainnet custody is not a prerequisite for a token-free Sepolia/service pilot. No outreach or account acceptance occurs automatically from this document.

The smallest first pilot is a free service from an independent developer, with one consumer outside that provider's project. It exercises identity, agent permissions, service discovery, a real request/result, revocation and optional publication without a token launch, mainnet funds or public inference. Record any Claus-operated consumer as such; it does not become a second independent participant.

Start from the published [client instructions](clients.md) and [service lifecycle](services.md). A credential-free connection check is:

```sh
node interfaces/cli.mjs call network_graph
```

Use `node interfaces/cli.mjs operations` and `node interfaces/cli.mjs describe service_register` to inspect the bundled operations and exact inputs offline. These commands do not check pilot admission or issue credentials.

The default API is `https://claus-network-api.vercel.app`. A successful connection check proves connectivity only. The participant records its own wallet and project IDs privately, obtains the specific project admission, and keeps all credential files outside source control. If a key rotation loses its response, follow the [interrupted-rotation recovery](clients.md#cli) instead of blindly retrying.
