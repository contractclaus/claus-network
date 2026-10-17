# Private data recovery

Save private project files without exposing storage credentials. The backup contains exact binary bytes, a checksum manifest, original file identities and current server identities. Uploads or deletions that are still pending remain metadata; they are never reported as recovered files.

## Back up

Use Node 24 and the downloaded clients. Set `CLAUS_NETWORK_IDENTITY_FILE` to your existing private identity file, or `CLAUS_NETWORK_TOKEN_FILE` to a private delegated token file. Backup requires `artifact.read` and `infrastructure.read` for the source project. Restore requires `artifact.read` and `artifact.write` for its destination.

```sh
node interfaces/data-cli.mjs backup PROJECT_ID ./private-backup
node interfaces/data-cli.mjs inspect ./private-backup
```

The destination directory must be new. It is created with private permissions, as are its files. `manifest.json` is written last, after every ready file has been downloaded and verified. A changed source inventory fails explicitly and leaves an incomplete directory; start a fresh backup rather than treating partial files as complete. The offline `inspect` command needs no wallet or API connection.

Files are stored under their content hashes, so names cannot escape the backup directory. Binary files and duplicate content are supported. The current data limits remain 50 MiB per file and 100 MiB/1,000 active files per project; this client does not increase account limits.

## Restore files

```sh
node interfaces/data-cli.mjs restore DESTINATION_PROJECT_ID ./private-backup
```

The client verifies the manifest and every byte before sending its first write. It checks destination capacity and derives a stable restore request for each original file. Running the same restoration again resumes those identities instead of creating duplicate files. Existing unrelated destination files are left intact. A conflicting or subsequently deleted restore identity fails explicitly.

A lost response is not a confirmed failure. Keep this same backup and destination and reconcile the returned original file ID. The client never creates a replacement request to hide an uncertain outcome.

## Scope

This recovers private data files. The resource inventory is historical information: it helps identify an existing server after interruption and never starts another machine. Jobs, payment requests, approvals, credentials and financial allocations are not activated by restoring this backup.

Signed project transfer archives also retain safe metadata for private files, OCI builds and infrastructure resources. External object bytes remain a separate export. Neither export is a complete hosting/database migration or a claim that an independent recovery host has been tested.

## SDK

`interfaces/data-backup.mjs` exports `exportDataBackup`, `verifyDataBackup` and `restoreDataBackup`. Provide a private `writeBlob(hash, bytes)` sink or a `readBlob(hash, expectedBytes)` source. The helpers use the existing API and MCP operation semantics; they receive no provider key and cannot replay financial or server actions.

## Complete application database

For managed app records, service state and request receipts, use [Application database recovery](app-database-recovery.md). The file backup above does not replace the app database backup.
