# Project UIs

Static publication is available under public technical admission. Check `capabilities` for current availability. The website is optional for the complete workflow.

Upload static source through `snapshot_create`, then call `release_create` with a snapshot ID and an explicit list of files, including `index.html`. Only the selected HTML, CSS, JavaScript, JSON and SVG files become part of the immutable release. Private notes or other snapshot files are not included automatically. No uploaded installation script or build command executes on the host.

`release_publish` separately publishes or withdraws that release. Omit `expiresAt` or pass `null` for publication without an automatic expiry. Existing explicit deadlines remain enforced; a future deadline may be supplied or renewed without changing the content. Public source publication, a project profile and a UI release are three separate choices.

UIs are served on `claus-network-sites.vercel.app`, outside the Claus application origin. A CSP sandbox gives scripts an opaque origin and no application cookies, wallet credentials or private API access. Network requests, workers, forms, nested frames and external assets are restricted. Static local assets remain available. Multi-page sites and local JavaScript/Canvas games work, including filenames such as `app.v2.js`. Raster images can be embedded as data URLs; embedded data fonts and audio are permitted. Multiplayer servers, browser API credentials and custom backend execution are not provided. Do not design these pages as an authenticated dashboard or ask users to enter secrets into an untrusted project's UI.

The technical limits are 256 files per snapshot/release, 1,000,000 UTF-8 bytes per file and 3,000,000 serialized JSON bytes total (including paths and hashes). Upload requests allow 3,200,000 bytes. Current project/release quotas are reported by `capabilities`; they retain consumed usage when raised. `public_release_file` serves one selected file without downloading the entire release. Withdrawal and expiry are checked on every uncached request. A page already downloaded into a browser cannot be remotely erased. Hosting an interface does not approve its claims or its contracts.

Newly published project profiles appear automatically in Home and Activity. The profile and its UI publication are separate: call `project_publish` as well as `release_publish`. Map positions are retained during refresh; a failed refresh keeps the last complete map.
