import {publicActivityQuery,publicActivityResponse} from './activity.mjs';
import {executionSummaryQuery} from './execution.mjs';
import {publicDirectoryQuery} from './search.mjs';
import {documentByteLimit} from '../shared/index.mjs';
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
      async readMany(collection, ids) {
        assertActive(); text(collection); requireThat(Array.isArray(ids) && ids.length <= 1000, 'invalid_ids'); ids.forEach(id=>text(id));
        if (!ids.length) return new Map();
        const { rows } = await client.query(`SELECT id,revision,body FROM ${documents} WHERE collection=$1 AND id=ANY($2::text[])`, [collection, ids]);
        return new Map(rows.map(row => [row.id, {revision:integer(Number(row.revision),1),value:row.body}]));
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
      },
      async pendingDataFiles({at,limit=4}) {
        assertActive();integer(at);integer(limit,1,10);
        const {rows}=await client.query(`SELECT id,revision,body FROM ${documents} WHERE collection='data-files' AND ((body->>'state'='uploading' AND (body->>'uploadDeadline')::bigint<=$1) OR body->>'state'='deleting') AND COALESCE((body->>'nextCleanupAt')::bigint,0)<=$1 ORDER BY id LIMIT $2`,[at,limit]);
        return rows.map(r=>({id:r.id,revision:integer(Number(r.revision),1),value:r.body}));
      },
      async pendingInfrastructure({after='',limit=20}={}) {
        assertActive();requireThat(typeof after==='string','invalid_cursor');integer(limit,1,100);
        const {rows}=await client.query(`SELECT id,revision,body FROM ${documents} WHERE collection='infrastructure-resources' AND id>$1 AND body->>'billing'='reserved' ORDER BY id LIMIT $2`,[after,limit]);
        return rows.map(r=>({id:r.id,revision:integer(Number(r.revision),1),value:r.body}));
      }
    };
  }
  return {
    ...reader(pool),
    // Multi-record observations share a database snapshot without acquiring the
    // global writer lock. No write/event handle is passed to the callback.
    async snapshot(run){
      const client=await pool.connect();let active=true;
      try{
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query("SET LOCAL statement_timeout='5s'");
        await client.query("SET LOCAL idle_in_transaction_session_timeout='8s'");
        const result=await run(reader(client,()=>requireThat(active,'transaction_closed')));
        await client.query('COMMIT');return result;
      }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
      finally{active=false;client.release();}
    },
    // Admission counts are independent of domain/financial transitions. Atomic
    // row updates retain existing counters and roll both reservations back on denial.
    async consumeRateLimits({ entries, window }) {
      integer(window); requireThat(Array.isArray(entries) && entries.length === 2 && new Set(entries.map(e=>e.id)).size === 2, 'invalid_rate_entries');
      for (const e of entries) { text(e.id); integer(e.maximum,1); }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL statement_timeout='5s'");
        await client.query("SET LOCAL lock_timeout='2s'");
        await client.query("SET LOCAL idle_in_transaction_session_timeout='8s'");
        for (const {id,maximum} of entries) {
          const result=await client.query(`INSERT INTO ${documents} AS d(collection,id,revision,body)
            VALUES('rate-limits',$1,1,jsonb_build_object('window',$2::bigint,'count',1,'expiresAt',($2::bigint+2)*300000))
            ON CONFLICT(collection,id) DO UPDATE SET revision=d.revision+1,
              body=jsonb_build_object('window',$2::bigint,'count',CASE WHEN (d.body->>'window')::bigint=$2 THEN (d.body->>'count')::bigint+1 ELSE 1 END,'expiresAt',($2::bigint+2)*300000)
            WHERE (d.body->>'window')::bigint<>$2 OR (d.body->>'count')::bigint<$3 RETURNING id`,[id,window,maximum]);
          requireThat(result.rows.length===1,'rate_limited');
        }
        await client.query('COMMIT');
      } catch(error) { await client.query('ROLLBACK').catch(()=>{}); throw error; }
      finally { client.release(); }
    },
    async workerExecutionSummary(at) {
      integer(at);const client=await pool.connect();
      try{await client.query('BEGIN READ ONLY');await client.query("SET LOCAL statement_timeout='3s'");const result=await client.query(executionSummaryQuery(documents),[at]);await client.query('COMMIT');return result.rows;}
      catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}
      finally{client.release();}
    },
    async workerExecutionStates() {
      // Do not transfer private source, inputs, output or provider handles just
      // to compute health. One extra row detects coverage beyond the limit.
      const {rows}=await pool.query(`SELECT jsonb_build_object('state',body->>'state',
        'finishedAt',body->'finishedAt','lease',jsonb_build_object('until',body->'lease'->'until')) AS body
        FROM ${documents} WHERE collection='worker-runs' ORDER BY id LIMIT 1001`);
      return rows.map(row=>({value:row.body}));
    },
    async publicActivity(input) {
      const {sql,params}=publicActivityQuery(schema,input),client=await pool.connect();
      try {await client.query('BEGIN READ ONLY');await client.query("SET LOCAL statement_timeout='3s'");
        const {rows}=await client.query(sql,params);await client.query('COMMIT');return publicActivityResponse(rows,input);
      }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
    },
    async searchPublicDirectory(input) {
      const {sql,params}=publicDirectoryQuery(schema,input),client=await pool.connect();
      try {
        await client.query('BEGIN READ ONLY');
        await client.query("SET LOCAL statement_timeout='5s'");
        await client.query("SET LOCAL lock_timeout='2s'");
        const {rows}=await client.query(sql,params);
        await client.query('COMMIT');
        const page=rows.slice(0,input.limit);
        return {items:page.map(row=>({id:row.id,revision:Number(row.revision),value:row.body,slug:row.slug,portfolio:row.portfolio})),nextCursor:rows.length>input.limit?page.at(-1).id:null};
      }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
    },
    async dueWorkflows({at,limit=4}) {
      integer(at);integer(limit,1,4);
      const {rows}=await pool.query(`SELECT id,revision,body FROM ${documents} WHERE collection='app-workflows' AND body->>'state'='active' AND (body->>'nextAt')::bigint <= $1 ORDER BY (body->>'nextAt')::bigint,id LIMIT $2`,[at,limit]);
      return rows.map(row=>({id:row.id,revision:Number(row.revision),value:row.body}));
    },
    async pruneEphemeral() {
      const { rows } = await pool.query(`SELECT "${schema}".prune_ephemeral() AS removed`);
      return { removed: Number(rows[0].removed) };
    },
    async transaction(run, {projectId} = {}) {
      if(projectId!==undefined)text(projectId);
      const client = await pool.connect();
      let active = true;
      const assertActive = () => requireThat(active, 'transaction_closed');
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL statement_timeout='10s'");
        await client.query("SET LOCAL idle_in_transaction_session_timeout='15s'");
        // Global writers (including older deployments) exclude scoped writes.
        // Different projects may publish together; revocation/policy/payment
        // transitions still synchronize with every publication.
        if(projectId===undefined)await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[schema]);
        else {
          await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[schema]);
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1))',[schema+':project:'+projectId]);
        }
        const tx = {
          ...reader(client, assertActive),
          async write(collection, id, value, expectedRevision) {
            assertActive(); text(collection); text(id); integer(expectedRevision);
            if(projectId!==undefined)requireThat(['public-projects','public-sources','project-public-agents'].includes(collection)&&value.projectId===projectId,'invalid_project_transaction_write');
            const body = canonical(value);
            // A bounded transaction stores both calldata and encrypted signed
            // bytes. Other documents retain the public 64 KiB ceiling.
            requireThat(Buffer.byteLength(body) <= documentByteLimit(collection), 'document_too_large');
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
            if(projectId!==undefined)requireThat(value.projectId===projectId,'invalid_project_transaction_event');
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
