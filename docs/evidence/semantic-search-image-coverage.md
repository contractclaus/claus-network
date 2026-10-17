# Exact image and issuer evidence

The current release is bound in `semantic-search-release.json`. The additional
`semantic-search-image-inventory.json` records bytes read from its published OCI
registry, including the index, Linux/amd64 manifest, configuration, all ten
compressed layers, selected final filesystem entries and package metadata.
Every fetched object's SHA-256 was checked against its parent descriptor.
Layer ordering and whiteouts were applied before comparing application files
with the release's source hashes. This is operator-produced evidence, not an
independent security assessment.

The inspection can be reproduced without Docker or a credential:

```sh
node scripts/inspect-semantic-search-image.mjs /tmp/search-image-inventory.json
node scripts/verify-semantic-search-release.mjs
```

The inspection uses Node.js and Python 3's standard library. It reads the public
registry and writes only temporary files and the requested JSON output. It does
not start a service, install packages, invoke a compiler or create a paid job.

Observed properties of the current image:

- Debian 12/bookworm, Python 3.12.15, and libc6 2.36-9+deb12u14.
- Both the base image's `libstdc++.so.6.0.30` and the copy selected through
  `LD_LIBRARY_PATH` have SHA-256
  `e7848e32af4932840ba775169041759a2a8dd5a008af360e5c55bce506eebcf4`.
  The override therefore does not replace that library with different bytes.
  The inventory separately records libgomp and its ELF dependencies.
- User `10001:10001`, working directory `/app`, port 8080, and command
  `python server.py`. The configuration and ELF dependency records are included.
- The final-stage history includes `python -c "from server import Engine;
  Engine()"` after the application, libraries, environment and non-root user
  have been set. The original successful build therefore includes model
  initialization under that final filesystem and environment. This does not
  establish live HTTP service or substitute for an independent runtime test.
- Installed Python distribution metadata is included, including dependencies
  declared by ONNX Runtime and Tokenizers that are not installed. The successful
  initialization is evidence only for the application path exercised by that
  build command; optional package features need separate assessment if used.

`verification: false` in the compiled artifact distinguishes compilation from
security approval. It does not mean that the recorded successful build failed.
The runtime release remains unapproved until an independent report and a genuine
Claus decision meet the release gate.

The ticket issuer is present at `src/discovery/admission.mjs`. It authorizes
`service.call`, reads the registered project's owner from the trusted store,
applies capacity across that owner's projects, and signs bounded claims with
Ed25519. `semantic-search-image-coverage.json` binds this file's hash to the
deployed API. `semantic-search-admission-key.json` contains an expired real
issuer signature for comparison with the public key inside the image. The
runtime handler, API route and client remain in `interfaces/service.mjs`,
`interfaces/contract.mjs`, `runtime/server.mjs` and
`reference/native-operations/src/network-semantic-search.ts`.

The public registry is the original independent source for re-reading the image
bytes. No inventory result grants approval, execution rights or spending.
