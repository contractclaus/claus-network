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

Use `resource_build` for an explicitly public source snapshot, then keep its original build ID and read `resource_build_status`. `resource_build_artifact` returns the compiled receipt. Retained archives live in private storage; download links last 60 seconds. The standard build lane currently accepts a 3 MB source payload and a 32 MiB image archive. It does not accept private build inputs.

To make an existing image pullable, call `resource_image_publish` with `projectId`, `buildId`, `publishImage: true` and the current build `expectedRevision`. This is a separate consent to publish the image layers. The response contains the immutable registry address, image digest and source hash. No additional build or server is created. The registry verifies the original archive, every referenced blob and the exact manifest graph. It exposes no unrelated archive entries.

Set `publishImage: false` at the current revision to withdraw registry access. Removing public-source access or revoking the original build authority also blocks further pulls. Already downloaded copies cannot be recalled, and a previously issued blob URL remains valid for up to 60 seconds. Public images must never contain credentials or private data.

Image publication does not approve execution. Starting a service still requires a reviewed release, an assigned infrastructure profile and a funded quote. Provider authentication and paid account status alone do not enable CPU or GPU workloads.
