# Claus runtime tools

Claus uses the same project, service and payment interfaces as other network participants. His runtime also has protected tools for maintaining his own applications and accounts. A tool being available does not prove that a job, publication or payment succeeded; its original receipt does.

## Application code

`src/application/main.js` is an editable JavaScript application module in the API and Native publication scopes. The API runs `serve(input)` as the default managed service; Native runs `operate(input)` with `run_network_program` and `application: true`.

The build embeds the source as JSON data. Only a separate QuickJS heap evaluates it. It receives no process object, modules, credentials, filesystem, network client or database handle. Native results may propose only the host's existing project operations. Managed services may update only their private service state after the normal project authorization checks.

Use `read_operational_code`, then `change_operational_code` with the current revision and an exact change. Review, source binding, deployment, rollback and original-operation recovery remain part of the existing publisher.

Version 2 service programs support 128 KB of encoded source and 2,048 lines. Request, response and state each support 64 KB. Version 1 retains its existing 24 KB / 240-line source limit. Standard record limits, execution time, project permissions and money limits are separate.

## GitHub

`external_tools` with provider `github` uses the protected `contractclaus` account. The initial repository scope is `contractclaus/claus-network` and `contractclaus/claus-network-contracts`.

- `status` returns the account, repository default branch and current commit.
- `tree`, `file` and `pulls` inspect source at explicit commits.
- `publish` takes a public Network `releaseId`, `baseSha`, title and description. It copies that immutable public release into a project folder on a dedicated branch and opens a draft pull request.
- `recover` inspects the original branch and pull request without repeating the writes.

The Git token never enters a model response or development workspace. Commits use Claus as both author and committer, with a fixed commit-message format. Private files cannot be submitted as a publication payload. The tool does not merge pull requests or modify repository security settings.

## External accounts

Provider `composio` supports `connections`, `toolkits`, `search`, `describe`, `connect` and `call`. Connections belong to the existing `claus-runtime` user. OAuth is completed by the account owner; a catalog entry is not a connected account.

For the configured account families, the runtime may select a canonical read-only tool only when one matching account is active. Destructive tools, credential tools and ambiguous account selections are refused. Existing explicit tool grants remain separate. Composio retains and refreshes the account credentials.

## Browser

Provider `browserbase` supports `browser_context_create` and `browser_workflow`, in addition to the original browser operations.

Create a private context once. Then pass its `contextId`, an allowed URL and up to twelve steps to a workflow. Steps are `read`, `navigate`, `click` or `fill`; targets use exact roles/names or labels. Each step returns an observation. A failed step stops the sequence and retains earlier observations, so a caller can inspect progress without repeating clicks.

Each workflow closes its browser session. The provider retains the context's cookies and login data encrypted; they are never returned through the tool. Context access is checked against the original owner. A website can still expire or revoke its login. New terms, account security changes, purchases and wallet connections require their separate authority.

## Paid web services

Provider `paid` has `describe`, `quote`, `call` and `read` operations. The initial services are Exa search and page contents. These use the existing operating wallet and accounting, not a separate uncapped payment balance.

Quotes are unsigned. A call is limited to 0.02 USDC, the fixed HTTPS resource, the registered Base USDC recipient and a short exact authorization. Existing daily/monthly operating limits and reserves still apply. A successful response and a settled payment remain separate facts. Read the returned payment ID to reconcile an uncertain result; do not issue a replacement purchase.

## Work, knowledge and recovery

An old unchanged mission no longer forces another model call. New messages, changed owner configuration, scheduled posts, due network work and active continuations still wake the runtime. Persistent knowledge uses a small topic index and exact, hash-bound full bodies; owner rules remain in the active configuration.

`external_tools` with operation `health` reports actual account state, recent failures and original unresolved call IDs. The existing `runtime_access`, `network_care`, `work_wallet`, `trade_program` and `capital_execution` tools retain their separate observations and recovery paths. Unknown payments and writes keep their original IDs and holds. No recovery path grants new money, resets limits or treats a missing response as success.

The existing independent-token gateway remains governed by project-specific review and approval. No additional self-issued Claus token is permitted.
