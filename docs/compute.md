# Project inference

Read `GET /v1/public/capabilities` before submitting work. `inference.enabled` reports current admission. A route or model listing alone does not grant funding.

Use your existing Claus project credential. Keep provider credentials on the server. `inference_profiles` lists the models and allowances available to this project; `inference_profile` returns the exact current profile hash, limits and expiry. A new or rotated credential does not reset the project's allowance.

The assigned gateway profile supports text input, bounded conversations, inline images and function-call proposals. Read current capabilities and your assigned profile before using a feature; the provider catalog alone does not establish gateway support. Streaming and structured-output guarantees are not exposed.

Conversation input can contain user or assistant messages, original `function_call` items and their matching `function_call_output` items. User content can include text and inline PNG/JPEG/WebP images. Hosted image URLs, file IDs and server-side conversation IDs are not accepted. Conversation input is bounded to 64 items and 65,536 bytes, subject to the profile's limits. Optional `tools` contains at most eight function definitions; input and definitions must fit the profile's byte limit. See the [inference guide](/docs/inference#conversations-and-function-calls) for item formats and continuation rules.

1. Read `inference_profile` for your project and profile ID.
2. Call `inference_submit` with its `profileHash`, exact model, text or conversation `input`, `maxOutputTokens` and a stable `idempotencyKey`. Include function definitions only when needed and supported by the profile.
3. Preserve the returned request and job IDs. Poll `inference_get`; retrieve available `text` and any `toolCalls` with `inference_output`.
4. Inspect function-call proposals before executing anything. The inference service does not execute tools or grant wallet, server or project privileges. Your application can act only through its own authorized interfaces and should validate returned arguments.
5. Treat `work` and `cost.state` independently. Output can be ready while payment remains pending. An unknown outcome retains its reservation. Never replace an uncertain request with a new payment attempt.

A conversation continuation is a new, separately metered request with its own stable idempotency key. Recover an uncertain original request before submitting a continuation. Unsent requests can be cancelled. Revoking funding prevents new submissions and undispatched work; it does not undo completed inference or erase its costs.

## Funding and privacy

A project receives only its allocated share of a finite parent policy. Reserved and spent amounts count toward it. Parent funding is shared with its payment account and is not a guarantee of provider capacity. No automatic top-up is implied. The initial service quotes in integer micro-USDC on Base; 1,000,000 units equals 1 USDC. Projects have no claim to withdraw that operating allocation as cash.

Submitted text, conversation content, inline images, function definitions and included function results are sent to the selected provider for inference. Do not submit credentials or other projects' private data. The profile identifies its data policy and the provider. See [Surplus privacy](https://www.surplusintelligence.ai/privacy-policy) and [gateway documentation](https://www.surplusintelligence.ai/docs/getting-started/whitelabel).

## Delegated sponsorship

Only the network owner sets `compute_policy_set`. Named issuers such as Claus can read `compute_policy`, inspect `compute_grants` and call `compute_grant_set` within that policy. Grants identify a project, purpose, maximum, expiry and revision. For revocation, set `enabled:false` and retain exactly the sum of `reserved + spent` as the limit. This frees only unused allocation. Per-project and overall ceilings remain enforced across concurrent grants and key changes.
