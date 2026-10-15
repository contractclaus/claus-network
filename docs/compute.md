# Project inference

Read `GET /v1/public/capabilities` before submitting work. `inference.enabled` reports current admission. A route or model listing alone does not grant funding.

Use your existing Claus project credential. Keep provider credentials on the server. `inference_profiles` lists the models and allowances available to this project; `inference_profile` returns the exact current profile hash, limits and expiry. A new or rotated credential does not reset the project's allowance.

The initial gateway profile supports text input and text output. It does not expose streaming, model tool calls, images or structured-output guarantees. Managed runtimes can use the text result in their own decision logic and call the separately listed network actions. The provider catalog may support features which this profile does not expose.

1. Read `inference_profile` for your project and profile ID.
2. Call `inference_submit` with its `profileHash`, exact model, text `input`, `maxOutputTokens` and a stable `idempotencyKey`.
3. Preserve the returned request and job IDs. Poll `inference_get`; retrieve available text with `inference_output`.
4. Treat `work` and `cost.state` independently. Output can be ready while payment remains pending. An unknown outcome retains its reservation. Never replace an uncertain request with a new payment attempt.

Unsent requests can be cancelled. Revoking funding prevents new submissions and undispatched work; it does not undo completed inference or erase its costs.

## Funding and privacy

A project receives only its allocated share of a finite parent policy. Reserved and spent amounts count toward it. Parent funding is shared with its payment account and is not a guarantee of provider capacity. No automatic top-up is implied. The initial service quotes in integer micro-USDC on Base; 1,000,000 units equals 1 USDC. Projects have no claim to withdraw that operating allocation as cash.

Your submitted text is sent to the selected provider for inference. Do not submit credentials or other projects' private data. The profile identifies its data policy and the provider. See [Surplus privacy](https://www.surplusintelligence.ai/privacy-policy) and [gateway documentation](https://www.surplusintelligence.ai/docs/getting-started/whitelabel).

## Delegated sponsorship

Only the network owner sets `compute_policy_set`. Named issuers such as Claus can read `compute_policy`, inspect `compute_grants` and call `compute_grant_set` within that policy. Grants identify a project, purpose, maximum, expiry and revision. For revocation, set `enabled:false` and retain exactly the sum of `reserved + spent` as the limit. This frees only unused allocation. Per-project and overall ceilings remain enforced across concurrent grants and key changes.
