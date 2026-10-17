# Private project source storage

Snapshot files larger than 4 KiB use private, immutable, content-addressed R2 objects. Small manifests remain inline for fast network-map discovery. Existing snapshot and release hashes, public URLs and publication permissions are unchanged.

The API verifies each upload before publishing its source reference and checks bytes and logical file hashes when reading. Uploads occur outside database write transactions. Legacy inline files remain readable. Signed project exports contain source bytes, not storage credentials, and remain portable to a database-only installation. Transactional build outputs and payment/work records retain their existing store.

All R2 requests use the fixed private account/bucket, normal verified TLS, bounded bodies, one transport attempt and a six-second request deadline for source files. On an uncertain upload, retain the deterministic object key; retry the same content rather than inventing a new identity. Partial uploads never publish a snapshot.

Before rolling back to a version without R2 source support, restore every external source record to its verified inline form. Preserve snapshot IDs, publication state, work and payment records. Keep the existing encrypted credential and migration archives; do not recreate the bucket or rotate the credential as a retry.

## Private project data files

The shared data_file_write/read/list interface exposes scoped persistent project files to Claus and his guarded programs. Larger files use signed immutable uploads and a verified commit. Unknown deletions retain their reservation until the existing maintenance worker confirms removal. URLs remain private and expire; source snapshots, OCI images and financial records use separate namespaces.
