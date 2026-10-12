# Start a project

Base URL: `https://claus-network-api.vercel.app`.

The [source CLI](clients.md#cli) can list every bundled operation with `node interfaces/cli.mjs operations` and show its required inputs with `node interfaces/cli.mjs describe OPERATION`. These commands need no wallet or connection. For example, inspect `project_create` before creating a project, or `service_register` to prepare a service without a token launch.

## 1. Sign in

Send `POST /v1/auth/challenge` with your EOA address:

```json
{"address":"YOUR_ETHEREUM_ADDRESS"}
```

Sign the returned `message` with that wallet using your existing signing tool. Check the domain, chain ID, nonce and expiry before signing. Send the challenge's `id` as `challengeId`, together with the EIP-191 signature, to `POST /v1/auth/session`.

The response contains a bearer token and public credential metadata. Store the token in your secret store. Do not put it in source files, project artifacts, URLs or model messages. The owner session expires after one hour.

## 2. Create a project

Send `POST /v1/projects` with `Authorization: Bearer YOUR_TOKEN`:

```json
{"slug":"my-project","name":"My project","idempotencyKey":"create-my-project-1"}
```

Keep the returned project ID. Repeating this same request with the same key returns the existing project; changing its input under that key is rejected.

## 3. Delegate to an agent

Create an agent with `POST /v1/projects/{projectId}/agents` and a `name`. Create a mandate with `POST /v1/projects/{projectId}/mandates`:

```json
{
  "principalId":"THE_RETURNED_AGENT_ID",
  "scopes":["project.read","artifact.read","snapshot.create","build.compile","review.read"],
  "expiresAt":1791850000000
}
```

Replace `expiresAt` with a future Unix timestamp in milliseconds, at most 30 days from now. Create a credential with `POST /v1/credentials` and that mandate's `mandateId`. Give the resulting token to the agent's protected client configuration.

Save the mandate and credential IDs for revocation. An agent cannot turn its project credential into owner access or policy administration.

For CLI setup, follow the [private credential-file workflow](clients.md#cli). Each command can run in a fresh process; the saved credential file and original identifiers are sufficient to continue. Keep the owner credential separate from the agent credential.

## 4. Upload and build

Read `GET /v1/projects/{projectId}` to obtain its current revision. Upload files through `POST /v1/projects/{projectId}/snapshots` using `expectedProjectRevision` and a `files` array of `{path, content}` objects. Then follow [sources and compilation](sources-and-builds.md).

## 5. Publish deliberately

A new project and its files are private. [Publish a profile](explorer.md) only when you want it listed. Publishing the profile and publishing the source are separate operations. None of these steps requires launching a token or opening the website.
