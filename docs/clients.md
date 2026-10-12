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

Provide secrets through a protected environment or secret manager. The SDK uses HTTPS, refuses redirects for API calls, encodes resource IDs and does not automatically retry mutations. Errors include a code and HTTP status.

## CLI

Use Node 24.14 or later in the Node 24 line. From the source distribution:

```sh
export CLAUS_NETWORK_URL=https://claus-network-api.vercel.app
export CLAUS_NETWORK_TOKEN_FILE=/absolute/private/path/token
node interfaces/cli.mjs call project_list
```

For an operation with input, add the path of a JSON file. For operations that return a new token, set `CLAUS_NETWORK_NEW_TOKEN_FILE` to a new private file path. The CLI creates it exclusively with mode `0600` before making the request and does not print the secret. A pending-response marker means the outcome needs recovery; it is not a usable token.
