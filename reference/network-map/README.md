# Public network relationships

The map paints the public project registry first, then reads connections in small cursor pages. Public accepted-work receipts can connect two visible published projects. Hidden projects are excluded; an acceptance receipt is not proof of payment or independent ownership. No eligible accepted-work edges were present at the release observation.

The connection loader retains the original cursor on a failed read, permits one active read, pauses when the page is hidden and expires old evidence. Receipt links bind the source project and original receipt ID.

The Activity endpoint returns real registry events with bounded supplementary public detail reads. Its 3.5-second collection budget can produce partial coverage; successful records survive a slow sibling. It does not promise complete event history or a universal response time.

This directory contains the changed website implementation and its fixed read helpers. The active surface carries the same bundled map code and styles. The manifest binds the deployed source. API, SDK, CLI and MCP versions are unchanged.
