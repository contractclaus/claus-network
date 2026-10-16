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

Composio is connected for catalog/schema discovery and three public Hacker News tools: `HACKERNEWS_GET_TOP_STORIES`, `HACKERNEWS_GET_ITEM` and `HACKERNEWS_SEARCH_POSTS`. The toolkit uses NO_AUTH, so these reads require no linked user account. No other application accounts have been linked. Finding a tool does not grant access to its application. Instant, workbench, proxy execution and connection management are disabled; no paid Instant integrations are activated.

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

## Reusable provider adapters

`adapter_save` stores an immutable template with a content-addressed adapter ID. It is data, not host code. All parameters are required and typed. Values are inserted as JSON values; no JavaScript or string evaluation runs in the host.

```js
const saved = await tools('save-hn-reader', {
  operation: 'adapter_save',
  input: JSON.stringify({
    name: 'hackernews-item',
    description: 'Read a public Hacker News item by ID.',
    provider: 'composio', operation: 'call',
    parameters: { id: { type: 'integer', minimum: 1 } },
    input: { tool: 'HACKERNEWS_GET_ITEM', arguments: { id: { $param: 'id' } } }
  })
});
const adapterId = saved.result.adapterId;
const item = await tools('read-hn-item-8863', {
  operation: 'adapter_call',
  input: JSON.stringify({ adapterId, parameters: { id: 8863 } })
});
```

Use `adapter_list` to find saved templates and `adapter_read` with `{adapterId}` to inspect one. A project's templates survive its individual development commands and remain private to that project and Claus' main context. Claus' main library is available to his development projects. A changed template receives a different ID; existing versions and their original receipts remain intact.

Invocations use the existing provider gateway. Current allowlists, fixed resources and write holds still apply, including after a tool is revoked. Templates cannot supply host credentials or grant new access. The API call retains its adapter ID and typed parameters in its original private action. Repeating the original action reads its receipt rather than invoking the provider again. For a fresh observation, use a new request ID intentionally.

## Knowledge loaded when needed

Long current-topic bodies can reference an immutable memory by ID, SHA-256 and character count. The fixed configuration retains each summary, visibility and source metadata; owner rules remain in configuration. Exact `read_knowledge` requests and full-text searches load the pinned body. Catalogue reads do not load every full body. Pagination uses the same configuration/publication snapshot before and after loading.

A missing source, changed hash or wrong visibility fails explicitly. Private Network bodies cannot be read through the Club channel. The original topic ID stays stable, so callers do not need to learn a new retrieval tool. Memory contents remain evidence, never permission.


## Browser load diagnostics

For a specific loading problem, add `diagnostics: true` to the existing browser input:

```js
const observation = await tools('observe-network-load-001', {
  provider: 'browserbase', operation: 'browser_open',
  input: JSON.stringify({ url: 'https://claus.si/Network', diagnostics: true })
});
```

This measures only the top-level document, with embedded frame URLs listed separately. It does not inspect child-frame content or navigate unapproved frame origins. This adds a dated snapshot of navigation and paint timings, up to 60 slow resource requests, and readiness of up to 100 HTML images. SVG image elements are counted; their requests and CSS images may appear in resource timings. The optional observation waits at most 2.5 seconds for network idle. A pending lazy image is not necessarily broken; null timing, size or HTTP status is not evidence of a zero-byte request or failure. Cross-origin detail and older performance entries may be unavailable. This is one observation of the current page, not a universal benchmark or proof every part has rendered.

Diagnostic URLs omit query strings, fragments and credentials. The same authorized origins, original-action receipt and single-request session closure apply. Optional diagnostic failure leaves the successful page read available. Recovery reads the original receipt; it does not create another browser session. `status.browser.diagnostics` advertises availability. No new provider, paid plan, linked account or wallet authority is added.
