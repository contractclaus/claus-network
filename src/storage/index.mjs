import {documentByteLimit} from '../shared/index.mjs';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { canonical, copy, integer, requireThat, text } from '../shared/index.mjs';

// Queue reads as well as writes: callers must not observe an unfinished async
// transaction on this connection. Production uses the PostgreSQL adapter.
export function openStore(path) {
  const db = new DatabaseSync(path, { timeout: 0 });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS documents (
      collection TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
      body TEXT NOT NULL, PRIMARY KEY(collection,id));
    CREATE TABLE IF NOT EXISTS events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);`);
  const lookup = db.prepare('SELECT revision,body FROM documents WHERE collection=? AND id=?');
  let queue = Promise.resolve(), closed = false;
  const enqueue = run => {
    const result = queue.then(() => { requireThat(!closed, 'store_closed'); return run(); });
    queue = result.catch(() => {});
    return result;
  };
  const read = (collection, id) => {
    text(collection); text(id);
    const row = lookup.get(collection, id);
    return row ? { revision: row.revision, value: JSON.parse(row.body) } : null;
  };
  const list = (collection, { prefix = '', after = '', limit = 100, projectId }  = {}) => {
    text(collection); integer(limit, 1, 1000);
    requireThat(typeof prefix === 'string' && typeof after === 'string', 'invalid_cursor');
    if (projectId !== undefined) text(projectId);
    return db.prepare(`SELECT id,revision,body FROM documents WHERE collection=?
      AND substr(id,1,?)=? AND id>? AND (? IS NULL OR json_extract(body,'$.projectId')=?) ORDER BY id LIMIT ?`)
      .all(collection, prefix.length, prefix, after, projectId ?? null, projectId ?? null, limit)
      .map(row => ({ id: row.id, revision: row.revision, value: JSON.parse(row.body) }));
  };
  const events = ({ after = 0, limit = 1000 } = {}) => {
    integer(after); integer(limit, 1, 1000);
    return db.prepare('SELECT sequence,body FROM events WHERE sequence>? ORDER BY sequence LIMIT ?')
      .all(after, limit).map(row => ({ sequence: row.sequence, ...JSON.parse(row.body) }));
  };
  return {
    read: (...args) => enqueue(() => read(...args)),
    readMany: (collection, ids) => enqueue(() => {
      text(collection); requireThat(Array.isArray(ids) && ids.length <= 1000, 'invalid_ids'); ids.forEach(id=>text(id));
      return new Map(ids.map(id => [id,read(collection,id)]).filter(([,row]) => row));
    }),
    list: (...args) => enqueue(() => list(...args)),
    events: options => enqueue(() => events(options)),
    pruneEphemeral: (now = Date.now()) => enqueue(() => {
      integer(now);
      const result = db.prepare(`DELETE FROM documents WHERE (collection,id) IN (
        SELECT collection,id FROM documents WHERE collection IN ('auth-challenges','rate-limits')
          AND json_type(body,'$.expiresAt')='integer' AND json_extract(body,'$.expiresAt') < ?
        ORDER BY collection,id LIMIT 2000)`).run(now - 86400000);
      return { removed: Number(result.changes) };
    }),
    transaction: run => enqueue(async () => {
      const deadline = Date.now() + 5000;
      for (;;) {
        try { db.exec('BEGIN IMMEDIATE'); break; }
        catch (error) {
          if (!/locked|busy/i.test(error.message) || Date.now() >= deadline) throw error;
          await delay(10);
        }
      }
      let active = true;
      const assertActive = () => requireThat(active, 'transaction_closed');
      const tx = {
        read(...args) { assertActive(); return read(...args); },
        list(...args) { assertActive(); return list(...args); },
        events(...args) { assertActive(); return events(...args); },
        write(collection, id, value, expectedRevision) {
          assertActive(); text(collection); text(id); integer(expectedRevision);
          const body = canonical(value);
          // Match PostgreSQL: bounded transaction intent plus sealed raw bytes.
          requireThat(Buffer.byteLength(body) <= documentByteLimit(collection), 'document_too_large');
          requireThat((read(collection, id)?.revision ?? 0) === expectedRevision, 'revision_conflict');
          if (!expectedRevision) db.prepare('INSERT INTO documents VALUES (?,?,1,?)').run(collection, id, body);
          else requireThat(db.prepare(`UPDATE documents SET revision=revision+1,body=?
            WHERE collection=? AND id=? AND revision=?`).run(body, collection, id, expectedRevision).changes === 1,
          'revision_conflict');
          return { revision: expectedRevision + 1, value: copy(value) };
        },
        event(value) { assertActive(); db.prepare('INSERT INTO events(body) VALUES (?)').run(canonical(value)); }
      };
      try { const result = await run(tx); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
      finally { active = false; }
    }),
    close: () => enqueue(() => { closed = true; db.close(); })
  };
}
