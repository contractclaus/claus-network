import { canonical, copy, integer, requireThat, text } from '../shared/index.mjs';

// The host supplies a dedicated PostgreSQL pool. Connection strings never enter
// domain modules; the schema is configuration, never a client request value.
export async function openPostgresStore({ pool, schema = 'claus_network', migrate = false }) {
  requireThat(/^[a-z][a-z0-9_]{0,47}$/.test(schema), 'invalid_schema');
  const documents = `"${schema}".documents`, eventTable = `"${schema}".events`;
  if (migrate) {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}";
      CREATE TABLE IF NOT EXISTS ${documents} (
        collection text NOT NULL, id text NOT NULL, revision bigint NOT NULL CHECK(revision>0),
        body jsonb NOT NULL, PRIMARY KEY(collection,id));
      CREATE TABLE IF NOT EXISTS ${eventTable} (sequence bigserial PRIMARY KEY,body jsonb NOT NULL);`);
  }
  function reader(client, assertActive = () => {}) {
    return {
      async read(collection, id) {
        assertActive(); text(collection); text(id);
        const { rows } = await client.query(`SELECT revision,body FROM ${documents} WHERE collection=$1 AND id=$2`, [collection, id]);
        return rows[0] ? { revision: integer(Number(rows[0].revision), 1), value: rows[0].body } : null;
      },
      async list(collection, { prefix = '', after = '', limit = 100, projectId } = {}) {
        assertActive(); text(collection); integer(limit, 1, 1000);
        requireThat(typeof prefix === 'string' && typeof after === 'string', 'invalid_cursor');
        if (projectId !== undefined) text(projectId);
        const { rows } = await client.query(`SELECT id,revision,body FROM ${documents}
          WHERE collection=$1 AND left(id,length($2))=$2 AND id>$3 AND ($5::text IS NULL OR body->>'projectId'=$5) ORDER BY id LIMIT $4`, [collection, prefix, after, limit, projectId ?? null]);
        return rows.map(row => ({ id: row.id, revision: integer(Number(row.revision), 1), value: row.body }));
      },
      async events({ after = 0, limit = 1000 } = {}) {
        assertActive(); integer(after); integer(limit, 1, 1000);
        const { rows } = await client.query(`SELECT sequence,body FROM ${eventTable} WHERE sequence>$1 ORDER BY sequence LIMIT $2`, [after, limit]);
        return rows.map(row => ({ sequence: integer(Number(row.sequence), 1), ...row.body }));
      }
    };
  }
  return {
    ...reader(pool),
    async pruneEphemeral() {
      const { rows } = await pool.query(`SELECT "${schema}".prune_ephemeral() AS removed`);
      return { removed: Number(rows[0].removed) };
    },
    async transaction(run) {
      const client = await pool.connect();
      let active = true;
      const assertActive = () => requireThat(active, 'transaction_closed');
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL statement_timeout='10s'");
        await client.query("SET LOCAL idle_in_transaction_session_timeout='15s'");
        // M1 serializes short state transitions, not provider calls. Lock scope
        // is this schema; later partitioning must preserve cross-account moves.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [schema]);
        const tx = {
          ...reader(client, assertActive),
          async write(collection, id, value, expectedRevision) {
            assertActive(); text(collection); text(id); integer(expectedRevision);
            const body = canonical(value);
            requireThat(Buffer.byteLength(body) <= 65536, 'document_too_large');
            const result = expectedRevision === 0
              ? await client.query(`INSERT INTO ${documents}(collection,id,revision,body) VALUES($1,$2,1,$3::jsonb)
                  ON CONFLICT DO NOTHING RETURNING revision`, [collection, id, body])
              : await client.query(`UPDATE ${documents} SET revision=revision+1,body=$3::jsonb
                  WHERE collection=$1 AND id=$2 AND revision=$4 RETURNING revision`, [collection, id, body, expectedRevision]);
            requireThat(result.rows.length === 1, 'revision_conflict');
            return { revision: integer(Number(result.rows[0].revision), 1), value: copy(value) };
          },
          async event(value) {
            assertActive();
            await client.query(`INSERT INTO ${eventTable}(body) VALUES($1::jsonb)`, [canonical(value)]);
          }
        };
        const result = await run(tx);
        await client.query('COMMIT');
        return result;
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { active = false; client.release(); }
    },
    close: () => pool.end()
  };
}
