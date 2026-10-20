# Website delivery integrity

The Cloudflare edge selects the active service from the continuity authority. Website URLs, including every public `.json` alias, are forwarded unchanged to the web service. The website's `vercel.json` owns alias-to-handler rewrites. `/__network/` is the explicit raw API gateway. Native administration paths remain native. Never copy a second table of website aliases into the edge: it bypasses query selection, validation, cache/fallback behavior and health semantics.

`/health.json` describes public-content health, not merely configured native credentials. A 200 from an upstream health or login page does not prove the expected application responded. Check the intended schema and identity. Keep write destinations single-dispatch; an ambiguous timeout is not permission to repeat a payment or deployment.

## Project host

Canonical source is `hosting/render.mjs`, `hosting/navigation.mjs`, `hosting/gateway.mjs`, and `hosting/vercel.json`. Produce the existing Vercel host layout with `node hosting/prepare.mjs NEW_OUTPUT_DIRECTORY`; the output must not already exist. This creates files only and does not deploy. Preserve the existing project ID, domains and deployment controls when releasing.

`/r/<release>/<path>` serves exact published UTF-8 bytes. `/view/<release>/<path>` is the separate navigation-enhanced presentation. The host verifies `file.hash` using the canonical structured digest of `{path, content}`. This differs from the raw body SHA-256 exposed as `X-Claus-Source-Sha256`. Read limits apply while streaming, even without Content-Length. A withdrawn, expired or corrupt release must not be served from a fallback cache.

The main website waits for both iframe load and the matching `claus-site-ready` handshake. Browser load alone also fires for HTTP error pages. Unconfirmed frames time out and retry with backoff, retaining a previously working frame when available. Cleanup cancels obsolete timers and callbacks. New releases must preserve this behavior and the `/view/` host route together.

## Source and deployment state

`read_operational_code` / `change_operational_code` with repository scope include `hosting/`. A repository commit, its controlled source manifest, the deployed site host and the deployed web bundle are separate artifacts. Match each to the actual release; never advance just a commit ID while retaining changed files' old hashes. Existing independent publication review and protected-wallet rules still apply.

`manage_resources` `cloudflare_read` supports `worker_routes` and `rulesets` for diagnosing edge interception before changing application code. These are read-only and do not expose tokens or change authority.

After a change, verify the affected public URL/schema, source hashes, and current recovery package. Keep original work IDs, uncertain outcomes and previous observation periods. Operator repairs are not autonomous Claus cycles. A small set of passing route and integrity checks is not a claim that every possible failure has been ruled out.
