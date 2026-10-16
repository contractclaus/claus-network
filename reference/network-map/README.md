# Public network relationships

The map paints the public project registry first, then reads connections in small cursor pages. Public accepted-work receipts can connect two visible published projects. Hidden projects are excluded; an acceptance receipt is not proof of payment or independent ownership. No eligible accepted-work edges were present at the release observation.

The connection loader retains the original cursor on a failed read, permits one active read, pauses when the page is hidden and expires old evidence. Receipt links bind the source project and original receipt ID.

The Activity endpoint returns real registry events with bounded supplementary public detail reads. Its 3.5-second collection budget can produce partial coverage; successful records survive a slow sibling. It does not promise complete event history or a universal response time.

This directory contains the changed website implementation and its fixed read helpers. The active surface carries the same bundled map code and styles. The manifest binds the deployed source. API, SDK, CLI and MCP versions are unchanged.

## Activity and entry reads, 16 October 2026

The website now uses the bounded public Activity query instead of fetching task details across every project. Current project and publication permissions are applied before events are returned. A successful response marks the requested window complete and the historical coverage bounded (`historyComplete: false`); upstream failures remain unavailable. Activity links navigate to their actual project or task destination. The entry path loads its immediate project summary separately from deeper details. These changes do not generate demonstration activity or claim that all historical events fit one response.
