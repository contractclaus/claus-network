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

## Connected account integrations

Composio is connected for tool catalog search and schema discovery through a scoped project key and session. No application accounts have been linked yet and the host app-call allowlist is empty. Finding a tool does not grant access to its application. Instant, workbench, proxy execution and connection management are disabled; no paid Instant integrations are activated.

Browserbase is connected to the existing Free project. `status` reports `single-request`: `browser_open {url}` creates one short session, loads an approved HTTPS page, returns rendered text and controls, then closes it. Use another `browser_open` for another page. A real host request read the Claus builder guide and the provider confirmed the session completed. No provider keys, cookies or debugging URLs are returned.

Persistent sessions and multi-step click/fill interactions need a paid Browserbase plan and separate activation. The existing persistent adapter remains available for that future configuration; it is not advertised as active on the Free account. No plan upgrade, app OAuth grant, wallet permission, treasury destination, fee split or launch authority changed.

```js
const catalog = await tools('find-repository-tools', {
  provider: 'composio', operation: 'search',
  input: JSON.stringify({ query: 'Find public information about a GitHub repository' })
});
const page = await tools('read-builder-in-browser', {
  provider: 'browserbase', operation: 'browser_open',
  input: JSON.stringify({ url: 'https://claus.si/build.txt' })
});
```

The approved keys live only in the protected provider vault and Native host environment. Guest code uses the same temporary command-bound bridge. Original receipts and uncertain-write holds remain unchanged.

Official integration references:

- https://docs.composio.dev/reference/api-reference/tool-router
- https://docs.browserbase.com/reference/api/create-a-session
- https://docs.browserbase.com/reference/api/get-a-session
- https://docs.browserbase.com/reference/api/update-a-session
- https://docs.cdp.coinbase.com/x402/buyer/mcp-payments
