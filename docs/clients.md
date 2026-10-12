# MCP, SDK and CLI

All clients use the same service and authorization checks. A different transport does not add permissions.

## HTTP MCP

Endpoint: `https://claus-network-api.vercel.app/mcp`.

Use a client that supports Streamable HTTP, protocol version `2025-06-18`, and a protected bearer-token configuration. Requests are JSON-RPC POSTs with `Content-Type: application/json` and `Accept: application/json, text/event-stream`. GET streaming is not enabled; the server is stateless between HTTP requests.

`tools/list` exposes the implemented operations. Tool calls return structured results or `isError: true`. Check this flag even when the HTTP response is successful.

Credential creation, login-session creation and credential rotation are deliberately absent from model-facing tools. Bootstrap them using the API or CLI so raw credentials do not appear in a model's tool output. OAuth discovery and browser-driven OAuth are not currently implemented.

## JavaScript SDK

The reference client is `interfaces/sdk.mjs` in the source distribution:

```js
import { createClient } from './interfaces/sdk.mjs';

const client = createClient({
  origin: 'https://claus-network-api.vercel.app',
  token: process.env.CLAUS_NETWORK_TOKEN
});
const projects = await client.call('project_list', {});
```

The SDK and CLI default to `https://claus-network-api.vercel.app`. Set `origin` or `CLAUS_NETWORK_URL` explicitly when using another operator. Provide secrets through a protected environment or secret manager. The SDK uses HTTPS, refuses redirects for API calls, encodes resource IDs and does not automatically retry mutations. Errors include a code and HTTP status. An HTML page or other non-JSON response produces `invalid_api_response`; its contents are not included in the error.

## CLI

Use Node 24.14 or later in the Node 24 line. From the source distribution:

```sh
node interfaces/cli.mjs --help
node interfaces/cli.mjs operations
node interfaces/cli.mjs describe service_register
```

`operations` lists the bundled API operations as JSON. `describe` returns an operation's exact input schema, route, authentication requirement and whether its response needs a private credential file. Both commands run offline without reading credentials. Their `apiVersion` identifies the bundled schema, not the current server release. Listing an operation does not mean it is enabled for your project; consult the live [service status](https://claus-network-api.vercel.app/health) and [pilot requirements](external-pilot.md).

To make a request:

```sh
export CLAUS_NETWORK_URL=https://claus-network-api.vercel.app
export CLAUS_NETWORK_TOKEN_FILE=/absolute/private/path/token
node interfaces/cli.mjs call project_list
```

For an operation with input, add the path of a JSON file. For operations that return a new token, set `CLAUS_NETWORK_NEW_TOKEN_FILE` to a new private file path. The CLI creates it exclusively with mode `0600` before making the request and does not print the secret. A pending-response marker means the outcome needs recovery; it is not a usable token.

If a credential rotation loses its response, the previous key may already be revoked. Keep the pending file and the original mandate ID; do not repeat the rotation with a different output file. Use a valid owner session to revoke that mandate, then create a new mandate and credential with the intended scopes and expiry. Existing files are never overwritten, including when a command is repeated after an interruption. Never paste a token or signed login response into a model conversation.
