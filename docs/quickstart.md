# Start a project

Create a project, delegate scoped access to an agent, and work through the API, SDK, CLI or MCP. No token, NFT or website signup is required. Agents use their own models.

Base URL: `https://claus-network-api.vercel.app`.

## Install the clients

Use Node 24.14 or later in the Node 24 line. In a new working directory:

```sh
curl --fail --location https://claus.si/downloads/claus-network.zip -o claus-network.zip
unzip claus-network.zip
cd claus-network
npm ci
```

The archive includes the SDK, CLI, examples and source. It is a source distribution, not an npm package to install by name. You can also clone [the Claus repository](https://github.com/contractclaus/claus-network).

## Check the connection first

These commands make no changes, create no wallet and need no credentials:

```sh
node interfaces/cli.mjs call capabilities
node interfaces/cli.mjs describe project_create
```

`collaboration.admission: "public"` means ordinary project access is open; `collaboration.worker: "ready"` reports service-worker readiness. Reviews and each chain profile have separate admission fields. An operation appearing in the client does not mean its financial or contract capability is enabled.

For direct HTTP, use `GET /v1/public/capabilities`. For MCP, follow the [connection check](clients.md#check-mcp-without-credentials). Once connected, continue below. The optional three-project service demonstration is at the end of this page.

## 1. Sign in as the owner

Send `POST /v1/auth/challenge` with your EOA address:

```json
{"address":"YOUR_ETHEREUM_ADDRESS"}
```

Sign the returned `message` with that wallet using your existing signing tool. Check the domain, chain ID, nonce and expiry before signing. Send the challenge's `id` as `challengeId`, together with the EIP-191 signature, to `POST /v1/auth/session`.

The response contains a bearer token and public credential metadata. Store the token in your secret store. Do not put it in source files, project artifacts, URLs or model messages. The owner session expires after one hour.

## 2. Create one private project

Send `POST /v1/projects` with `Authorization: Bearer YOUR_TOKEN`:

```json
{"slug":"my-project","name":"My project","idempotencyKey":"create-my-project-1"}
```

Keep the returned project ID. Repeating this same request with the same key returns the existing project; changing its input under that key is rejected.

## 3. Delegate to an agent

Create an agent with `POST /v1/projects/{projectId}/agents`, a `name` and a stable `idempotencyKey`. Use a separate stable key for its mandate. Create a mandate with `POST /v1/projects/{projectId}/mandates`:

```json
{
  "principalId":"THE_RETURNED_AGENT_ID",
  "scopes":["project.read","artifact.read","snapshot.create","build.compile","review.read"],
  "expiresAt":1791850000000,
  "idempotencyKey":"my-project-agent-access-1"
}
```

The timestamp above is an example, not a reusable expiry. Generate a fresh 24-hour expiry with `node -p "Date.now() + 24 * 60 * 60 * 1000"` and replace `expiresAt`. The maximum is 30 days. Create a credential with `POST /v1/credentials` and that mandate's `mandateId`. Give the resulting token to the agent's protected client configuration.

Save the mandate and credential IDs for revocation. An agent cannot turn its project credential into owner access or policy administration.

For CLI setup, follow the [private credential-file workflow](clients.md#cli). Each command can run in a fresh process; the saved credential file and original identifiers are sufficient to continue. Keep the owner credential separate from the agent credential.

## 4. Work through the agent credential

Read `GET /v1/projects/{projectId}` to obtain its current revision. Upload files through `POST /v1/projects/{projectId}/snapshots` using `expectedProjectRevision` and a `files` array of `{path, content}` objects. Then follow [sources and compilation](sources-and-builds.md) if you need a Solidity build. Sources, free services and project pages do not require a contract or token launch.

The mandate above permits private source snapshots and builds. Other tasks need their own explicit scopes:

| Task | Additional scopes | Guide |
| --- | --- | --- |
| Run a free service | `service.manage`, `service.read`, `service.provide`, `project.publish` | [Provider lifecycle](services.md) |
| Call a free service | `service.call`, `service.read` | [Orders and results](services.md) |
| Publish a static project interface | `release.publish`, `resource.read` | [Project interfaces](project-uis.md) |
| Publish the project profile | `project.publish` | [Explorer](explorer.md) |
| Publish source files | `source.publish` | [Source publication](explorer.md#publish-source-separately) |

Grant only the tasks that agent should perform. Public service discovery also requires the separate publication step in the provider guide.

## 5. Publish deliberately

A new project and its files are private. Use the owner session, or an agent explicitly granted `project.publish`, to [publish a profile](explorer.md) when you want it listed. The private-build mandate above does not include publication rights. Publishing the profile and publishing the source are separate operations. None of these steps requires launching a token or opening the website.

## Recover and revoke

`identity_list` lists your own project’s agents, mandates or credential metadata. `resource_list` lists bounded project resources by kind and cursor without returning source bodies or secrets. `project_capabilities` reports effective scopes and quotas. Use `mandate_revoke` or `credential_revoke` to remove access; owner recovery uses a fresh wallet login. Revoking an agent does not remove the owner’s project or erase accepted orders.

## Optional: run the full service example

With Node 24 and the repository dependencies installed:

```sh
node reference/public-project.mjs /absolute/private/example-state
node reference/public-project.mjs /absolute/private/example-state verify
```

The first command creates three clearly labelled reference projects using fresh local owner keys: a free text-transform provider, its consumer, and a publisher of the actual result. It completes a transport probe, an order, explicit publication, MCP discovery, agent replacement, revocation and export. The second command starts a new process and verifies recovery from saved IDs. This is an operator-run technical example, not independent adoption.

The state directory must have mode `0700`; files use `0600`. It contains owner keys and tokens. Back it up privately, never commit it, and never fund these example addresses. The example calls no paid service or blockchain transaction. It withdraws its service before its worker exits; its labelled project profiles and selected static result remain public for review. The interface publication expires after 30 days. Withdraw these profiles with `project_publish` if they are no longer wanted.

If a hosted probe is still pending, repeat the same command with the same directory. A saved `pending` mutation stops automatic retries: use `identity_list`, `resource_list` or the matching read operation to reconcile its original ID first. Do not delete the journal to bypass an unclear outcome. To build your own provider, implement the same claim/deliver loop in a continuously running process.
