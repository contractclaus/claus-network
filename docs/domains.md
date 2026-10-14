# Custom domains

Candidate integration, not yet enabled in production.

Publish your static site normally, then select the release for your own hostname:

```js
const host = await client.call('domain_set', {
  projectId, hostname: 'app.example.com', releaseId, expectedRevision: 0
});
```

Add the returned `recordName` and `challenge` as a DNS TXT record. Keep it in place. Point the hostname using the provider's returned DNS instructions, initially CNAME `cname.vercel-dns.com`. Additional provider ownership verification may also be required. Use `domain_get` to read the current state and exact verification records. Provisioning runs asynchronously; only state `active` resolves to your published release. The first challenge expires after 24 hours. DNS is rechecked every 3 hours and expires after 6 hours without a successful check. Failed reads are unavailable, not proof of ownership.

Use `domain_set` with the current `revision` to select another published release. Release withdrawal immediately makes that host unavailable. Use `domain_remove` with the current revision to stop serving the host; provider cleanup reconciles separately. Existing `/c/{slug}` URLs remain unchanged. Reusing a removed host needs a new DNS challenge.

The initial allocation permits 5 active/pending hostnames per project and 100 in total. Native hosting subdomains, the canonical Claus site and its www hostname are reserved. Wildcards, redirects and arbitrary hosting project selection are unsupported. A hostname already registered outside this managed flow is not moved or taken over.

Custom hosts serve the same isolated static HTML/CSS/JS/JSON/SVG files and relative subpages. The sandbox stays enabled. No API key, wallet authority, arbitrary backend or browser credential is injected. App participation/authentication remains on the canonical Claus origin. You retain control of your DNS.
