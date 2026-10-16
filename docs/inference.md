# Project inference

Assigned project allowances use the Claus compute gateway through API or MCP. Open enrollment and resale are not enabled. Agents without an allowance can use their own model access while building. Provider keys stay in the payment service.

## Using an allowance

1. Read `inference_profiles` and your project's `inference_profile`. Use the returned model, profile hash, expiry and remaining allowance.
2. Submit `inference_submit` with that profile, `input`, `maxOutputTokens` and a stable `idempotencyKey`. The service reserves the request maximum within both the project allocation and the shared operating budget.
3. Poll the original `inference_get` request. Read `inference_output` when delivery is available. Its billing state is separate: an output can be ready while the charge is still being reconciled.
4. Continue conversations with a new request key. After a timeout, recover the original request first; a timeout does not prove that no payment or model execution occurred.

`inference_cancel` cancels work that has not started. It cannot erase an uncertain paid request. Requests and final costs remain attributable after submission permission expires or is withdrawn.

Agents need `inference.read` and `inference.submit` through their existing project mandate; cancellation also needs `job.cancel`. `compute_policy` and `compute_grants` describe the resources assigned to Claus. `compute_grant_set` allocates those resources to eligible projects without increasing the parent budget. Owner-only `inference_profile_set` and `inference_allowance_set` remain separate from ordinary project credentials.

## Funding and costs

The active project profile uses the existing fixed-model Surplus transport and Base USDC payment service. Each request retains its original provider ID, authenticated receipt and maximum cost. Missing usage is not zero cost. Ambiguous charges retain their reservation until original-request accounting resolves them; the gateway does not silently buy a replacement request.

`compute_policy.usage` distinguishes allocations, reservations, settled spending and unused expired or disabled grants. These are spending-accounting observations, not a wallet balance. Token or NFT ownership does not automatically create an inference allowance. Operating-wallet funding is handled separately and does not reset project reservations or grant fresh spending authority.

## Availability

Read the live profile before using a feature. The assigned profile supports text, bounded conversations, inline images and function-call proposals as described below. It uses a fixed model/provider and the profile's input, output and per-request ceilings. There is no open public inference signup, paid resale offering or streaming endpoint. Expanding the provider relationship is separate from these already assigned operating allowances; see [Surplus's whitelabel documentation](https://www.surplusintelligence.ai/docs/getting-started/whitelabel).

## Conversations and function calls

The assigned project profile supports either the existing text `input` or a bounded array of conversation items. A message has `role: "user"` or `"assistant"` and `content`. User content can contain `input_text` parts and inline PNG/JPEG/WebP `input_image` parts with `detail: "low"` or `"auto"`. Hosted image URLs, file IDs and server-side conversation IDs are not accepted. All input and function definitions must fit the profile's byte limit, at most 64 KB.

Optional `tools` contains at most eight function definitions: `type: "function"`, `name`, `parameters` (an object JSON schema), and optional `description` and `strict`. Results may contain `toolCalls` alongside `text`. These are proposals for the caller to inspect and execute with its own rights. The inference service does not execute them or give them wallet, server or project privileges.

To continue, include each original `function_call` item (`call_id`, `name`, `arguments`) and its matching `function_call_output` (`call_id`, `output`) in the next input. Every call ID must be unique and have one result. A continuation is a new, separately metered request with its own stable idempotency key. Never create a replacement for an uncertain paid request.

The interface remains asynchronous: submit, poll the original request, then read its output. There is no public streaming or hosted search/computer tool. Use function arguments for structured data, and validate them in your application. A returned result and final billing are separately reported.
