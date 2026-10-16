# External tools for Claus

The host exposes one `external_tools` interface to Claus and the same interface to his private development commands. This is a Claus runtime capability, not a new public API key that grants access to his accounts.

## Available without a provider account

- Public HTTPS documents and JSON through the existing address-validated reader, including pagination.
- API discovery through the official x402 Bazaar MCP service. Search returns service descriptions and prices. Discovery does not purchase or invoke paid endpoints.
- Private original-action receipts. An interrupted write is retained and prevents another mutation at that provider until resolved. Other work can continue.

```js
import { tools } from '/tmp/claus-tools.mjs';

const source = await tools('read-builder-guide', {
  provider: 'web', operation: 'read',
  input: JSON.stringify({ url: 'https://claus.si/build.txt' })
});
const services = await tools('find-weather-apis', {
  provider: 'bazaar', operation: 'search',
  input: JSON.stringify({ query: 'weather' })
});
```

Keep each request ID stable when recovering the same request. Use a new ID for an intentional new observation. API keys never enter the guest; its temporary grant is tied to the original active command and expires with that command. A copied grant cannot authorize another workspace, run after completion, or alter provider policy. These files can become reusable adapters in an existing project and be staged through the existing publication flow.

## Prepared account integrations

Composio supports searching tool schemas, generating connection links for allowed toolkits, and calling explicitly connected tools with fixed accounts and resource constraints. A provider key and an actual configured session are required. `instant:false` must be used when creating the session unless separate paid-service activation has been approved. Tool search results are not new authorization. Proxy execution and arbitrary credentials stay out of guest code.

Browserbase supports creating a bounded browser session, reading pages, navigating, clicking named controls, filling fields, and releasing the session. It requires the actual account, project and authorized origins. Sessions belong to their original caller. The adapter does not export cookies, debugging URLs, or provider credentials. Persistent reconnectable sessions require a supporting plan; account setup must establish that before activation.

Neither integration is represented as connected until its live status and a real authorized request confirm it. Creating accounts, accepting terms, and billing setup are separate from installing an adapter. No provider purchase, wallet permission, treasury destination, fee split or token-launch authority changes in this release.

Official integration references:

- https://docs.composio.dev/reference/api-reference/tool-router
- https://docs.browserbase.com/reference/api/create-a-session
- https://docs.browserbase.com/reference/api/get-a-session
- https://docs.browserbase.com/reference/api/update-a-session
- https://docs.cdp.coinbase.com/x402/buyer/mcp-payments
