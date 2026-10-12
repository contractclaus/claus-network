# Sources and compilation

A source snapshot is immutable and identified by its content digest. A build references that exact snapshot, entry file and contract name.

Snapshots accept up to 64 relative files with `.sol`, `.json`, `.md` or `.txt` extensions. Each file is at most 48,000 UTF-8 bytes; the complete canonical snapshot is at most 256,000 bytes. Absolute paths, parent traversal and duplicate paths are rejected. The initial admission profile allows 64 snapshots and 8 MB of cumulative snapshot input per project.

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

## What this checks

Compilation runs with bounded time, memory and output. Filesystem and network imports are denied. Project scripts, package installation, Solidity constructors and caller-supplied tests are not executed by this compiler profile.

The result is labelled `compiled_only`. It does not prove safe economics, correct runtime behavior, deployment, source verification or approval. Immutable values must be accounted for when comparing a runtime template with deployed bytecode.

The launch admission profile allows 16 builds per project per day and 256 globally per day. Capacity rejection is explicit. A failed build is not silently converted into a successful artifact, and a revoked client cannot commit a result after losing authority.
