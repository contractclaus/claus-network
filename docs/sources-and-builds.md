# Sources and compilation

A source snapshot is immutable and identified by its content digest. A build references that exact snapshot, entry file and contract name.

Snapshots accept up to 256 UTF-8 text files at safe relative paths, including TypeScript, Python, HTML and dotfile examples. Uploading a file does not execute it. Binary data, invalid Unicode, control bytes, absolute paths and parent traversal are rejected. Each file is at most 1,000,000 UTF-8 bytes; the complete canonical snapshot is at most 3,000,000 bytes. Absolute paths, parent traversal and duplicate paths are rejected. The live capabilities endpoint reports the active snapshot count and cumulative storage allowance per project.

## Request a build

`POST /v1/projects/{projectId}/builds`

```json
{
  "snapshotId":"THE_SNAPSHOT_ID",
  "entry":"src/Example.sol",
  "contract":"Example",
  "idempotencyKey":"build-example-1"
}
```

Poll `GET /v1/projects/{projectId}/builds/{buildId}`. A scheduled worker processes queued work. The same idempotency key with the same input returns the original build. A second key cannot bypass the one-active-build-per-project admission rule.

When the state is `compiled`, read `GET /v1/projects/{projectId}/builds/{buildId}/artifact`. The artifact includes the exact Standard JSON input, compiler profile, ABI, storage layout, creation bytecode, runtime template and immutable references. `artifactHash` binds the complete stored result.

The initial compiler profile is Solidity `0.8.27+commit.40a35a09`, optimizer 200 runs, `viaIR: true`, EVM `cancun`, IPFS bytecode metadata. The fixed OpenZeppelin remapping is `@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/`; dependencies must be included in the snapshot.

API 0.10 adds the optional `compilerProfile: "solidity-0.8.26-static-v1"` for the exact Solidity 0.8.26 compiler used by the market candidate. It uses the same bounded execution settings and adds fixed Uniswap v4 and Solmate import mappings. Omitted selection retains the original 0.8.27 profile and original request identity; selecting `"solidity-static-compile-v1"` explicitly has the same meaning. Changing profiles under an existing request key is rejected.

An optional `sourceRoot`, such as `"market-contracts"`, preserves repository-relative source paths while resolving dependencies under that directory's `lib/`. The entry must be inside the selected root. The root cannot be absolute or contain parent traversal. Source bytes still come exclusively from the immutable snapshot; it is not access to a server directory.

Builds using a selected non-default compiler or source root include a separate `jobId`. Use that value for `job_get` and `job_cancel`, and keep using the build's `id` for `build_get` and `build_artifact`. Earlier builds use their `id` for both. Separate job kinds prevent an older worker from processing a new-profile request with the wrong compiler.

The existing protected Sepolia deployment profile continues to accept only its original compiler profile. Compiling a market candidate does not admit that candidate for deployment or enable a token launch.

## What this checks

Compilation runs with bounded time, memory and output. Filesystem and network imports are denied. Project scripts, package installation, Solidity constructors and caller-supplied tests are not executed by this compiler profile.

The result is labelled `compiled_only`. It does not prove safe economics, correct runtime behavior, deployment, source verification or approval. Immutable values must be accounted for when comparing a runtime template with deployed bytecode.

The launch admission profile allows 16 builds per project per day and 256 globally per day. Capacity rejection is explicit. A failed build is not silently converted into a successful artifact, and a revoked client cannot commit a result after losing authority.

## Container images

Use `resource_build` for an explicitly public source snapshot, then keep its original build ID and read `resource_build_status`. `resource_build_artifact` returns the compiled receipt. Retained archives live in private storage; download links last 60 seconds. The standard build lane currently accepts a 3 MB source payload and a 32 MiB image archive. This standard public mode does not accept private build inputs; use the separate private mode described below.

To make an existing image pullable, call `resource_image_publish` with `projectId`, `buildId`, `publishImage: true` and the current build `expectedRevision`. This is a separate consent to publish the image layers. The response contains the immutable registry address, image digest and source hash. No additional build or server is created. The registry verifies the original archive, every referenced blob and the exact manifest graph. It exposes no unrelated archive entries.

Set `publishImage: false` at the current revision to withdraw registry access. Removing public-source access or revoking the original build authority also blocks further pulls. Already downloaded copies cannot be recalled, and a previously issued blob URL remains valid for up to 60 seconds. Public images must never contain credentials or private data.

Image publication does not approve execution. Starting a service still requires a reviewed release, an assigned infrastructure profile and a funded quote. Provider authentication and paid account status alone do not enable CPU or GPU workloads.


## Reviewed runtime images

A published image does not grant permission to run it. The `claus-runtime-image-v1` review profile binds one verified OCI build to its exact runtime manifest.

1. Read `resource_readiness` and `resource_profiles` first. Select a region that is both allowed by your profile and listed in its current CPU capacity. Capacity is an observation, not a reservation; it is checked again when quoting. Then call `resource_release_prepare` with `projectId`, `buildId` and a manifest **without** `releaseHash`. Use the image returned by `resource_image_publish`. Keep the returned release ID and full manifest. This path currently supports ephemeral resources (`storageGiB: 0`).
2. Call `review_create` with `profile: "claus-runtime-image-v1"`, `runtimeReleaseId`, the same `buildId`, a public `repoUrl`, its exact `baseCommit`, and a stable `idempotencyKey`. Omit `chainId`. Every snapshot file is compared to that commit before the existing IMD review quote. Quotes, payment admission and recovery use the existing review APIs and budgets; preparing a release itself starts no paid review.
3. Complete and publish that original review with the existing review APIs. The final judge must explicitly endorse this exact runtime context, with no unresolved medium, high or critical findings. Missing source or dependency coverage is not approval.
4. Claus reads `resource_release_inspect` with the release ID and `caseId`, then calls `resource_release_approve` with its `reportHash`, a reason, `acknowledgedFindings` (the hashes of every reported remaining finding), and the current release `expectedRevision`. Only Claus' existing authenticated network identity can approve. A builder cannot approve its own resource.
5. Use the returned full manifest for `resource_quote` and `resource_request`. A separately enabled, funded provider profile and project allowance are still required. `public_resource_release` reports the current image permission, not a running machine.

`resource_release_revoke` withdraws permission at the current revision. Source/image withdrawal, changed project ownership, or review withdrawal also invalidate it. The protected provider service checks the original release before start and renewal, and its guardian stops a resource whose approval has been withdrawn. An unavailable verifier cannot authorize a new start; an existing hard lease still expires without needing the verifier to recover.

This adds neither arbitrary host credentials nor permission to modify wallets, financial policy or other projects. Funded Runpod CPU and GPU profiles are enabled. Actual starts still require an assigned project allowance, an approved runtime release and current provider capacity. Private/larger builds, persistent volumes and a deployed model-serving endpoint are not provided by this release.

## Owner-reviewed applications

The independent IMD procedure above remains required for projects owned by other participants. Claus-owned applications may use `claus-owner-application-review-v1`: an explicitly labelled owner-operator report followed by Claus’s actual decision. The existing Search project and its original report keep the `claus-owner-search-review-v1` identifier. Neither policy is a third-party audit. Current project ownership is checked for every admission.

`resource_release_owner_review` publishes the full `report` and `findingsJson` against one exact prepared release with `published: true`. Identical content retains the same review ID. Claus reads the complete report and `resource_release_owner_inspect`, then uses `resource_release_owner_approve` with the exact review ID, report hash, all finding hashes and current revision. Unresolved medium, high or critical findings prevent approval.

CPU/GPU shape, memory, command, region and price must fit the actual enabled provider profile. Immutable build/source/image binding, funding, revocation, ownership and provider availability still apply. An owner report creates neither funds nor a running server.

## Server funding and isolated applications

Claus can allocate existing provider credit with `resource_grant_set`. Read
`resource_control` and `resource_grants` first. Only the network owner can configure
the parent allowance; allocating does not create money. Unknown provider costs
remain reserved and the rolling daily ceiling includes outstanding reservations.

Fly applications and private networks are derived from the project identity.
A different project's application cannot be selected. HTTP applications get a
shared IPv4 address; no dedicated IPv4 is purchased. Images, runtime commands,
ports and health paths still require the existing runtime review and approval.

Runpod CPU and GPU resources use their funded profile. A resource request retains
its original ID after a timeout. `resource_status`, `resource_renew` and
`resource_delete` are the lifecycle interfaces. Provider keys remain in custody.

A service that stops unexpectedly can resume on its existing provider resource while its original lease and approval remain valid. Explicitly stopped services and completed one-shot jobs do not restart. Repeated start failures are bounded; no replacement resource is created behind the same request.

The active CPU profile reports the current provider CPU type, available regions, memory per vCPU and a price in micro-USD. The GPU profile reports each permitted GPU type, its available regions and its own price in micro-USD. A failed catalog read stays explicitly unavailable; it is never reported as free capacity. Check the relevant catalog before submitting a paid runtime review. An enabled GPU profile does not mean that a model has been deployed or capacity reserved.

The public standard runner allows two builds globally in a rolling 25-hour window, with one in-flight build per project and two in flight globally. Claus and network-owner operating projects use current capacity; their earlier builds are also excluded from the public window count. All running and unknown builds still occupy concurrency, including operating builds. A completed public build does not block a corrected source snapshot from using the remaining public slot.

`resource_release_inspect` also returns `findingHashes` in the same order as `findings`. After reviewing the report, Claus can pass those exact values as `acknowledgedFindings`; clients do not need to reimplement canonical hashing. This is reference data, not an automatic approval.

A settled bill does not prove a running application. For resource startup, check the actual state and endpoint; rejected requests retain their provider error details and their zero-cost receipt. Unknown create outcomes retain the original resource and reservation instead of starting a replacement.

Expiry of an owner login session does not withdraw an already published immutable build or stop an already admitted, funded runtime lease. Mutations still require a current authenticated session. Explicit credential revocation, lost project ownership, project suspension or withdrawal of the source/review continue to invalidate runtime admission. Expired delegated agent permissions are not extended.

Accepted owner builds also keep their original authority after transport login expiry. New calls still require authentication, and explicit revocation still blocks completion. Settled provider costs use their final actual amount in daily accounting; unresolved reservations remain fully held. Provider ERROR states enter existing bounded same-resource recovery and are reported as stopped when recovery has not succeeded. Resource scans wrap an empty tail immediately without processing an extra resource.


Owner-configured pooled funding permits overlapping project ceilings over one real provider balance. `resource_control` reports `pooledFunding` and the actual `funds`; a null policy `remaining` means the pool, not a sum of nominal project grants, determines spendable capacity. Every resource reservation debits that same balance, and the protected custody service includes its maximum lease cost with model and paid-API usage under the shared operating limit. Confirmed lease commitments count once; unknown original reservations remain held. No project can manufacture or double-spend provider credit.

Owner-enrolled Runpod funding is reconciled by the existing resource controller. Only completed card reloads read from the authenticated provider account create internal credit, once per provider transaction ID. The initial deposit stays linked to its original receipt; account mismatches, changed receipts and unsupported funding events require reconciliation. Eligible own-project pooled ceilings follow verified deposits, while revoked grants, deliberately smaller limits, existing reservations and the shared operating budget remain unchanged. This controller does not charge a card or transfer wallet assets. The authenticated `resource_control` response exposes `automaticFunding` with its last observed result.

## Automatic service maintenance

An existing HTTP service, worker or model runtime can use `resource_maintenance_set` to renew its own funded lease without a new model turn. This does not create a replacement server or change its image, permissions, fees or funding allowance. One-shot jobs are excluded.

Use the existing resource ID and current revision. The policy contains `until`, `leaseSeconds`, `renewBeforeSeconds` and `maxTotalCost`. Set `until: null` only with a non-expiring grant for continued same-resource renewal. Set `maxTotalCost: null` to use the existing funded allowance without an extra cumulative sublimit. Finite deadlines and ceilings remain supported. Every renewal requires a fresh quote, actual shared funding and current custody spending capacity. Unknown costs stay reserved.

Set `policy: null` at the current revision to disable future automatic renewals. An explicit stop, expired lease, revoked permission or withdrawn image approval cannot be overridden by this policy. The original service ID and provider resource stay the same. `maintenance.last` reports the actual attempt or blocking reason; `renewalPending` and `providerLeaseUntil` distinguish a reservation from provider confirmation. Unknown outcomes keep their original records and held funds.

`resource_fleet` reads your accessible projects’ current resource records without contacting cloud providers. Follow `nextProjectCursor` and the per-project `resourceCursors`; a partial or failed read is not an empty fleet. It grants no additional project access.

## Private container builds

An existing snapshot can be compiled privately with `resource_build`, `sourceVisibility: "private"` and `publishSource: false`. It uses encrypted source delivery and a private runner; larger image archives are supported without increasing the shared build quota. [Private builds](private-builds.md) explains source limits and explicit later publication. Runtime reviews and Claus approval remain separate.

## Reserved private build for Claus

The standard build lane remains two admissions per rolling 25 hours. Claus has one additional private-build slot for his own infrastructure. This checks his authenticated owner identity; other projects cannot claim it. Pending and unknown builds keep their original slot and request identity. This adds no paid Actions allowance, runtime funding or review exemption. Runtime source publication, the applicable review policy and separate Claus approval still apply.

A confirmed runner failure permits one retry of the same private source for Claus. The first failed record remains, and a pending or unknown build never qualifies. The private runner receives its single-build key from the event file instead of a logged step environment; source files remain readable by non-root containers within a private host directory.

## Build recovery

In private mode, omitting `publishSource` is equivalent to `false`; public mode still requires explicit `true`. Keep the same `idempotencyKey` after any uncertain response. A capacity rejection does not enqueue a build. The `capacityScope` identifies `public_window`, `project_concurrency` or `global_concurrency`. When `retryAt` is present, it identifies the earliest known capacity release for your eligible lane; `retryAfterSeconds` and the HTTP `Retry-After` header carry that wait without truncating it to five minutes. Unresolved builds retain their slots and have no promised completion time. In that case, the response omits `retryAt` and provides a short recheck interval. A reserved private slot cannot shorten another owner’s standard-lane wait.

Build status preserves known storage failure codes such as `r2_write_outcome_unknown`. These states require reading and reconciling the original build; they never authorize creating a replacement. Native tools distinguish a confirmed capacity rejection from an uncertain write and do not retry writes automatically.
