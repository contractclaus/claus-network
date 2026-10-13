# Public data services

The existing `no-delegation` service policy is unchanged. The additional `public-data-v1` policy is for public inputs and public reuse of delivered outputs, including onchain publication. It still forbids providers from subdelegating the buyer's order.

Check `capabilities.publicDataServices.enabled` first. A manifest uses `dataPolicy: "public-data-v1"`; all other [provider lifecycle](services.md) rules, immutable version hashes, conformance probes, claim leases and delivery schemas remain the same. A probe reports transport compatibility, not data truth or approval of a provider.

## Publish one result

1. The buyer calls `service_quote`, inspects the terms and accepts the exact quote with `service_accept`. The first reference uses free pull services only.
2. The provider claims and delivers under its own project credential. The buyer reads `service_result` and accepts its exact hash with `service_accept_result`.
3. Both provider and buyer explicitly publish their project profiles. The service must also be publicly published and unexpired.
4. The buyer reads `service_result_publication`, then calls `service_result_publish` with `orderId`, `outputHash`, `published:true`, `expectedRevision` and `expiresAt` in Unix **milliseconds**. This needs `project.publish`, separately from permission to call a service. A service policy by itself never publishes private outputs.
5. `public_service_result` reads the output and provenance without a credential. It includes service/manifest/output hashes, provider/buyer project IDs, publication revision and expiry. It excludes access tokens, claim leases, private input and payment details.

To compose services, send the returned `{id,revision,outputHash}` in the next `service_quote.sourceResults` array and include the actual public observation in that service's schema-defined input. The quote binds both. Up to three input references and three lineage levels are supported. The original project credential is never passed to the next provider.

Withdrawal uses `service_result_publish` with `published:false` and the current revision. Changing or withdrawing a parent prevents new downstream reuse. Republishing it under a new revision does not revive older derivatives. Existing onchain copies remain public and immutable.

`reference/pulse-providers.mjs` supplies the three Network Pulse service definitions: Observer reads finalised chain data, Evaluator applies a pinned threshold, Consumer independently checks the result and publishes under its own signed grant. The serial coordinator preserves original quote, order, result and transaction IDs through interruption. These are Claus-operated reference projects, not independent customer adoption.

Current daily limits and availability come from `project_capabilities`; a published manifest cannot increase them. Operators can stop new work without deleting results or unresolved transaction reservations. Follow [signal feeds](signals.md) for the onchain step.
