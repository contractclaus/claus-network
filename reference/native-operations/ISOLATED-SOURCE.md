Current scope: Native14 additionally delegates the work-ordering program described in [operating isolation](OPERATING-ISOLATION.md). The analysis boundary below remains unchanged.

# Credential-free network analysis

This release narrows the delegated native/API source scopes to `src/isolated/network.json`. Website scope is unchanged. The JSON document contains version 1 and an array of source lines defining `analyze(input)`. It is data during the Node build, not an imported executable module. The trusted bridge evaluates those lines only in QuickJS, with no installed host handles, module loader, fetch, database or environment access.

The fixed native bridge passes project identifiers and availability states for metrics, public view, runtime and inference. It does not pass descriptions, runtime content, prompts, balances, jobs or secrets. The API bridge passes public worker role, heartbeat status and failed-worker count. Output is at most twenty advisory notes, each bound to an input subject, with priority `info` or `attention` and a message no longer than 320 characters. Neither raw observations, timestamps, pagination nor execution evidence can be overwritten. Advice is explicitly not verified evidence or authority. All action gates still apply.

Each execution has a fresh heap, 16 MiB memory, a 128 KiB stack and a 40 ms instruction deadline. Invalid or failed analysis produces an unavailable analysis field; it does not erase the original observations. Health reads execute the exact bundled program and expose its source hash. The publisher checks that hash and successful evaluation before activation, in addition to source, review, deployment and cron checks. Future reviews retain the original paid effect and deployment identity. Worker-side path checks also reject old non-isolated proposals before deployment or rollback.

Rollback restores a prior immutable code deployment; this lane cannot change a database schema, undo a payment, reset a cursor or change budgets. It is not general native/API source editing, arbitrary SQL, an operating-system shell or a migration authority. Those remain separate unfinished handover work.

The owner also fixes the original product-observation deadline defect in the trusted reader: all four component states are present, already-completed reads are preserved, and late responses cannot mutate the returned snapshot. This is an owner-authored repair, not a fabricated native implementation. The existing original repair work should inspect the real release and assess it without a replacement paid review.
