# Portable HTTP runtime bootstrap

The managed API and `node runtime/server.mjs` use the same runtime constructor. The standalone entry point loads configured inference, OCI builds, durable image storage, infrastructure, contract intake, application storage and existing network controls. Construction does not start a scheduler or perform provider work.

Production PostgreSQL access must pass the same restricted-role and receipt-boundary checks as the API. It never falls back to a local database. SQLite is available only with an explicit local-development flag; it cannot claim production database verification or enable PostgreSQL application storage.

The standalone listener defaults to `0.0.0.0` and `PORT=8787`, supports an explicit `HOST`, and serves the shared `/health` response. Termination drains HTTP requests, closes remaining connections after 15 seconds and closes the database pool. Original jobs and financial state are retained for existing recovery paths.

This fixes portability of the HTTP entry point. It does not activate another production host, replicate a database, provide a registry or install another worker scheduler. Host cutover, routing, backup restoration and fencing still need their original deployment and recovery procedures. Avoid running an extra scheduler alongside the existing dedicated worker service.
