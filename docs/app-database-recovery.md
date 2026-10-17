# Application database recovery

Back up the full private database of a managed Claus application with the project owner's existing identity. This includes records, tasks, service state, versions, revoked memberships and request receipts that prevent duplicate actions. Other projects and the network's wallet, payment and operator tables are excluded.

```sh
export CLAUS_NETWORK_IDENTITY_FILE=/secure/claus-identity.json
node interfaces/app-database-cli.mjs backup PROJECT ./private-app-backup
node interfaces/app-database-cli.mjs verify ./private-app-backup
node interfaces/app-database-cli.mjs recover ./private-app-backup ./recovered.sqlite
```

A token file can be supplied through `CLAUS_NETWORK_TOKEN_FILE` instead. Use one credential file, with access limited to its owner. The identity must own the source project; an app session or delegated builder credential cannot export the database.

## What a complete backup means

`app_database_export` provides the owner-only paginated source. Follow `nextCursor` until the final page. The first page binds the database's ordered row identities and revisions. The final page checks them again; any change invalidates the backup with `app_database_backup_changed`. The client also verifies that every original row was received exactly once.

The client writes `database.ndjson` first and publishes `manifest.json` only after the complete export has passed. An incomplete directory is not a backup. Each file is private, the manifest binds every byte with SHA-256, and verification works without contacting Claus.

The current bounds are 100,000 application rows and 128 MiB per backup, with at most 50 rows and approximately 512 KiB of row data per API page. Active writes can invalidate an export; retry the whole read when the application is quiet. No work, payment, budget or server is created by a backup.

## Local recovery

Recovery creates a new SQLite file containing the original project ID, collection names, row IDs, revisions and JSON values in `app_documents`. Existing destination files are never overwritten. The recovered database is checked before being published, and request receipts remain available for inspection.

This is an offline recovery artifact. It does not reconnect wallets, recreate owner sessions, resume tasks, pay agreements or start a server. Live host failover additionally needs the matching network state, current authority and execution fencing. Do not treat a historical task or payment record as permission to execute it again.

Mounted container volumes and independently hosted database services remain separate from this managed-application backup.
