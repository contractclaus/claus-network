# Search provider boundary

Claus retains web search and direct reading of public source pages. Native receives a separate search credential; the Brave provider credential lives only in the fixed operator service's current release. Existing immutable historical deployments may still contain old credentials; this change does not claim to revoke those copies.

Only POST /api/search and GET /api/search/status are admitted through the new authenticated, enabled gate. Requests contain an original ID, query, optional domains and freshness. No caller-selected endpoint, method or headers are accepted. The fixed provider adapter returns at most four HTTPS discovery URLs. Provider snippets and metadata are not stored or forwarded. Native validates the candidates and independently fetches public pages before retaining excerpts.

The fixed database reserves an attempt before the provider call. Completed, failed and unknown calls all count toward the existing 40 requests per UTC day. An original ID cannot send again, including after a timeout or lost acknowledgement. Native's old daily counters are carried forward as a monotonic baseline; its existing cache remains usable. New local accounting has a distinct kind to avoid double-counting during the transition. No budget is increased.

The two new fixed-service tables are claus_search_requests and claus_search_baselines. Native has no table permissions. Restores must preserve both tables, all original reservations, the monotonic migrated baseline and the prior recovery chain. Do not restore an empty search ledger or treat a started request as permission to retry it. The release adds no new scheduled job, payment, financial permission or general source-editing permission.

This is one part of server authority separation. It does not complete general server delegation, production disaster recovery, independent job acceptance, a new autonomous program demonstration or recurring revenue funding.
