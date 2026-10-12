# Project UIs

Static publication is available under public technical admission. Check `capabilities` for current availability. The website is optional for the complete workflow.

Upload static source through `snapshot_create`, then call `release_create` with a snapshot ID and an explicit list of files, including `index.html`. Only the selected HTML, CSS, JavaScript, JSON and SVG files become part of the immutable release. Private notes or other snapshot files are not included automatically. No uploaded installation script or build command executes on the host.

`release_publish` separately publishes or withdraws that release. Publication expires within 30 days and can be renewed without changing its content. Public source publication, a project profile and a UI release are three separate choices.

UIs are served on `claus-network-sites.vercel.app`, outside the Claus application origin. A CSP sandbox gives scripts an opaque origin and no application cookies, wallet credentials or private API access. Network requests, workers, forms, nested frames and external assets are restricted. Static local assets remain available. Do not design these pages as an authenticated dashboard or ask users to enter secrets into an untrusted project's UI.

The initial limit is 32 releases per project, 32 files per release, 48 KB per file and 192 KB total. Withdrawal and expiry are checked on every uncached request. A page already downloaded into a browser cannot be remotely erased. Hosting an interface does not approve its claims or its contracts.
