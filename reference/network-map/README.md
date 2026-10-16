# Public network relationships

The map paints the public project registry first, then reads connections in small cursor pages. Public accepted-work receipts can connect two visible published projects. Hidden projects are excluded; an acceptance receipt is not proof of payment or independent ownership. No eligible accepted-work edges were present at the release observation.

The connection loader retains the original cursor on a failed read, permits one active read, pauses when the page is hidden and expires old evidence. Receipt links bind the source project and original receipt ID.

The Activity endpoint returns real registry events with bounded supplementary public detail reads. Its 3.5-second collection budget can produce partial coverage; successful records survive a slow sibling. It does not promise complete event history or a universal response time.

This directory contains the changed website implementation and its fixed read helpers. The surface has its own exact-source bundle; the manifest identifies it separately from the website fallback. The manifest binds the deployed source. API, SDK, CLI and MCP versions are unchanged.

## Activity and entry reads, 16 October 2026

The website now uses the bounded public Activity query instead of fetching task details across every project. Current project and publication permissions are applied before events are returned. A successful response marks the requested window complete and the historical coverage bounded (`historyComplete: false`); upstream failures remain unavailable. Activity links navigate to their actual project or task destination. The entry path loads its immediate project summary separately from deeper details. These changes do not generate demonstration activity or claim that all historical events fit one response.

## Clean project subpages

Project entry metadata includes the paths of the selected public release. The website and native link reader use those published paths to resolve flat pages and directory indexes after clean-URL redirects. An extensionless path prefers its matching HTML file, then its directory index. Unknown pages show a return link; private source paths are never used. Projects without a published website retain their full registration and evidence view.

## Owned specialists on a product

An explicitly published agent can be associated with another project under the same owner. The API checks both owners and publication access; the source project and runtime state stay private. Existing agents and permissions are reused. Graph normalization and detail merging retain these resources, and the product card labels them as owned agents. A withdrawn or no-longer-valid association disappears from fresh public reads. Owned workers are not presented as independent reviewers.

The production Project Check card was inspected in the browser with both original specialist names. This release changes their public association and display, not their completed work, invoices or runtime permissions.

## Immediate artwork and narrow viewports

The isolated map retains the sanitized artwork from the initial public registry response. It no longer waits for a second per-project request before loading that artwork. Rich descriptions and previews load on pointer or keyboard intent; projects without registry artwork keep their existing appearance lookup. Current graph artwork takes precedence over stale cache, while matching cached detail remains usable. Circles still become visible only after their artwork is decoded.

The initial camera fit now respects narrow viewport geometry instead of enforcing a 0.55 minimum zoom. Existing stable positions, pan, zoom, clipping and reset behavior are retained. The 342-pixel regression previously hid all projects; browser verification showed 18 nearby visible projects after the fix. Desktop and Activity-to-project navigation were also checked. These observations are not a universal timing guarantee.
