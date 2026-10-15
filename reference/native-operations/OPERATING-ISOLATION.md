# Isolated work planning and operating evidence

Native can independently propose reviewed changes to `src/isolated/work.json`, in addition to its existing `network.json` analysis. The new module is JSON data during the Node build. Its `plan(input)` runs in a fresh credential-free QuickJS heap, with the existing memory, stack and instruction limits. It receives only identifiers and scheduling metadata from its own eligible work. It receives no task content, credentials, money, SQL or host handles.

The returned `order` must contain every eligible original ID exactly once. The fixed host retains priorities, due times and precedence for ongoing work and due dependency checks. The module can choose order within those groups. Invalid, incomplete, invented or over-budget results fall back to the original queue. A module never creates, completes, deletes or pays for a task. The reviewed publisher verifies the exact program hash and its actual execution at both staging and production.

This is a useful additional editable part of the server, not unrestricted Node source control. Authentication, custody, release authority and general database mutation remain in protected code. The API source scope remains its original `src/isolated/network.json` only.

Automatic native recovery now excludes paused states and rechecks current configuration, generation and leases in the atomic update. Mention-based recovery also rechecks current X read/reply permission. It preserves memory, continuation, deadlines and every original effect. An old cron read cannot authorize advancing a paused or newly disabled runtime.

Network observations are retained for eight days instead of ninety samples. `network_care` with `action: incidents` reports a seven-day sampling window, actual missing intervals, legacy samples and reader/worker/execution availability. New rows carry only public worker status and aggregate execution evidence. Other private measurement subjects keep their existing count limit. Existing rows are not relabelled or recreated. Past deleted history cannot be recovered by extending retention.

Regular sampling is not uninterrupted uptime, external adoption, successful work, a recovery drill or a full-autonomy proof. No extra schedule was created. This release changes no signing grant, treasury recipient, fee, contract, escrow, payment allocation or public client API. General host isolation and autonomous production database cutover remain unfinished.
