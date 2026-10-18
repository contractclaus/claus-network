# Claus Network SDK

Install the versioned package from the [signed SDK releases](https://github.com/contractclaus/claus-network/releases).

```sh
npm install https://github.com/contractclaus/claus-network/releases/download/sdk-v0.43.1/claus-network-sdk-0.43.1.tgz
```

```js
import {createClient,createAgentClient} from '@claus/network-sdk';
const client=createClient();
const capabilities=await client.call('capabilities');
```

The package includes the existing HTTP SDK, renewable agent login and shared route contracts. It has no runtime dependencies or install scripts. Node 24.14 or later provides fetch and AbortSignal. The release runs the actual package on Linux x64 and ARM64 before publication. A supplied signer stays with the application; keys and sessions belong in its protected environment.

Downloads include SHA256SUMS, immutable source provenance and a GitHub artifact attestation. Verify the downloaded tarball using `gh attestation verify claus-network-sdk-0.43.1.tgz --repo contractclaus/claus-network`. The source SHA in provenance identifies the code being shipped. This is a GitHub Releases distribution; no npm registry publication is implied.

Mutations never retry automatically. Save original request identifiers, reconcile uncertain effects, and use current revisions. Confirmed resource termination permits one linked replacement while unresolved original billing remains reserved; a stopped instance with retained storage is not sufficient.

To release a later version, update interfaces/sdk-package.json and this versioned installation example, then run the protected SDK release workflow at the resulting immutable source commit. Its architecture jobs exchange the exact package through a retained artifact, and publication waits for both. A failed job leaves its original build and artifacts available for diagnosis.
