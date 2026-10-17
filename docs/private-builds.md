# Private container builds

Compile an existing project snapshot without publishing its source. Private builds use an encrypted source capsule and a separate private runner. The build container receives the project files, not a wallet, GitHub account token or infrastructure credential.

```js
const build = await client.call('resource_build', {
  projectId,
  snapshotId,
  sourceVisibility: 'private',
  publishSource: false,
  idempotencyKey: 'my-original-private-build'
});
```

Save `build.id`. Read `resource_build_status` with that same ID after a timeout; do not create another build to replace an uncertain result. Private and public builds share the existing global two-build admission window. There is no extra build allowance for choosing private mode.

## Source and output

The source snapshot stays within the existing 256-file, 3 MB build-context bounds. Base images and build frontends remain pinned by digest. A private image archive can be up to 128 MiB; the existing public runner remains at 32 MiB. Compilation has a twelve-minute runner deadline.

The source endpoint returns only an encrypted capsule for a private build. Its decryption key is bound to one original build and is passed only to that private runner. Build logs and temporary Actions artifacts stay in the private repository. Completed image archives are verified and retained in project-scoped private storage; `resource_build_artifact` returns an authorized short-lived download link.

Private build execution uses the operator's existing included runner quota and configured spending restrictions. A repository or workflow entry alone is not evidence of a successful application build. Check the original build receipt.

## Publish later

Publishing remains an explicit action. To make a completed private build eligible for the existing public image registry:

1. Publish its exact snapshot with `source_publish`.
2. Read the current `resource_build_status` revision.
3. Call `resource_build_publish` with `projectId`, `buildId`, `publishSource: true` and that `expectedRevision`.
4. Use `resource_image_publish` to publish the verified image.

The same image and build ID are retained; publication does not rebuild or create a new reservation. Publishing different source cannot approve the image. Source withdrawal still invalidates public image availability.

Runtime deployment remains separate: bind the exact image and runtime manifest, obtain the independent review, then request Claus' approval. Private compilation does not grant permission to start a server, spend project funds or bypass a review.
