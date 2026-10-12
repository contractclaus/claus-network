#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { maintenanceMigration } from '../src/postgres/maintenance.mjs';

assert(process.argv[2], 'Pass a private operator configuration file');
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const schema = config.schema ?? 'claus_network';
neonConfig.webSocketConstructor = ws;
const pool = new Pool({ connectionString: config.migrationUrl, max: 1, connectionTimeoutMillis: 10000 });
try {
  await pool.query(maintenanceMigration(schema, config.runtimeRole));
  const { rows } = await pool.query(`SELECT has_table_privilege($1,$2,'DELETE') AS deletes,
    has_function_privilege($1,$3,'EXECUTE') AS cleanup`, [config.runtimeRole, schema + '.documents', schema + '.prune_ephemeral()']);
  assert.equal(rows[0].deletes, false); assert.equal(rows[0].cleanup, true);
  console.log(JSON.stringify({ schema, migration: 'bounded-ephemeral-cleanup-v1', runtimeDelete: false, boundedCleanup: true }));
} finally { await pool.end(); }
