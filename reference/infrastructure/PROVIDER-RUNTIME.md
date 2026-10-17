# Provider runtime

The project API uses the existing project credential and immutable resource ID for provider operations. `resource_readiness` reports whether provider access is configured; this is separate from a funded allowance, approved release and working application. CPU/GPU creation remains disabled until those prerequisites are present.

## Lifecycle

1. Read `resource_profiles` and `resource_readiness`.
2. Submit `resource_quote` for the exact reviewed manifest and digest-pinned image.
3. Use one `resource_request` idempotency key. Read the returned resource ID through `resource_status`.
4. To continue a running service, obtain a fresh quote for the same manifest and call `resource_renew` with its current revision. `renewalPending` stays true until custody acknowledges `providerLeaseUntil`. A timeout is not evidence that a second machine is needed.
5. `resource_stop` preserves provider state where supported. `resource_delete` requests removal. `terminal`, `storageRetained` and `cost.state` describe different facts.

Renewals preserve the original resource identity. Each renewal and quote use has its own durable record; the live resource retains a bounded latest-extension record rather than accumulating its entire history. Funding is reserved before extension. A missing provider acknowledgement never silently authorizes an unfunded extension.

## Execution and recovery

The API does not receive provider credentials. Its fixed custody endpoint authenticates the exact request, returns a signed response and binds the account, reviewed manifest and original provider ID. A custody lease serializes start, stop, renewal and guard operations. The controller writes the dispatch intention before contacting the provider.

Only a signed `not_started` observation allows continuation of the same original request. A lost or ambiguous create is searched using the original resource identity and is never blindly repeated. Runpod inventory search retains its pagination cursor. Changes to current admission cannot erase the original reconciliation context.

An independent custody guardian checks existing resources once per minute, even when the model or project API is not taking a turn. It requests deletion after the funded lease expires, the protected provider profile is revoked or observed pricing exceeds the quote. Provider outages can delay deletion; the quote reserves shutdown headroom, and unknown costs remain reserved. This is not an unconditional provider uptime or spending guarantee.

HTTP readiness requires an application health response. A provider reporting that a pod is running is insufficient. Logs are bounded untrusted data. Confirmed terminal resources release their compute capacity without releasing unknown financial obligations.

## Current limits

The Runpod adapter uses REST v2 for catalog, pod lifecycle, health, logs and billing observations. The Fly adapter targets an explicitly configured application in the Claus organization. It does not silently provision in another account. Initial manifests use ephemeral boot disks; persistent volumes, private networking, registry credentials and project ingress require their own configured lifecycle.

Runpod billing history is an observation, not a final invoice. A missing or zero delayed billing bucket does not release a reservation. The Fly adapter similarly does not invent final costs. The existing source build lane exports a temporary OCI archive; durable registry publication, large/private builds and a complete unattended final-billing path remain separate work.

No new GPU/CPU instance, paid review, wallet transaction, token launch or public inference resale is created by installing this controller. Existing coin rules, financial holds and the prohibition on a second self-issued CLAUS token remain unchanged.
