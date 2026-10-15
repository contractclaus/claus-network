import { canonical, copy, integer, requireThat, text } from '../shared/index.mjs';

// Separate application tables and app-local locks. Financial/network transitions
// retain their existing transaction implementation.
export async function openAppPostgres({ pool, schema = 'claus_network', migrate = false }) {
  requireThat(/^[a-z][a-z0-9_]{0,47}$/.test(schema), 'invalid_schema');
  const docs = `"${schema}".app_documents`, network = `"${schema}".documents`;
  if (migrate) await pool.query(`CREATE TABLE IF NOT EXISTS ${docs} (
    app_id text NOT NULL, collection text NOT NULL, id text NOT NULL,
    revision bigint NOT NULL CHECK(revision>0), body jsonb NOT NULL,
    PRIMARY KEY(app_id,collection,id));
    CREATE INDEX IF NOT EXISTS app_author ON ${docs}(app_id,collection,(body->>'authorId'),id);
    CREATE INDEX IF NOT EXISTS app_parent ON ${docs}(app_id,collection,(body->>'parentId'),id);
    CREATE INDEX IF NOT EXISTS app_assignee ON ${docs}(app_id,collection,(body->>'assigneeId'),id);
    CREATE INDEX IF NOT EXISTS app_catalog ON ${docs}(app_id) WHERE collection='meta' AND id='app';
    CREATE INDEX IF NOT EXISTS app_state ON ${docs}(app_id,collection,(body->>'state'),id);`);
  function reader(client, appId, locked = false) {
    return {
      network: { async read(collection, id) {
        // FOR SHARE also applies UPDATE row policies. Global controls are
        // intentionally read-only to this role and are fenced by the shared
        // network advisory lock held for every application transaction.
        const lockRow = locked && !['network','network-capabilities'].includes(collection);
        const { rows } = await client.query(`SELECT revision,body FROM ${network} WHERE collection=$1 AND id=$2${lockRow ? ' FOR SHARE' : ''}`, [collection,id]);
        return rows[0] ? { revision:Number(rows[0].revision),value:rows[0].body } : null;
      } },
      async read(collection,id) {
        const { rows } = await client.query(`SELECT revision,body FROM ${docs} WHERE app_id=$1 AND collection=$2 AND id=$3`,[appId,collection,id]);
        return rows[0] ? { revision:Number(rows[0].revision),value:rows[0].body } : null;
      },
      async list(collection,{after='',limit=50,authorId,state,parentId,assigneeId}={}) {
        integer(limit,1,100);text(collection);
        const values=[appId,collection,after,limit];
        let filter='';
        if(authorId!==undefined){values.push(authorId);filter+=` AND body->>'authorId'=$${values.length}`;}
        if(parentId!==undefined){values.push(parentId);filter+=` AND body->>'parentId'=$${values.length}`;}
        if(assigneeId!==undefined){values.push(assigneeId);filter+=` AND body->>'assigneeId'=$${values.length}`;}
        if(state!==undefined){values.push(state);filter+=` AND body->>'state'=$${values.length}`;}
        const {rows}=await client.query(`SELECT id,revision,body FROM ${docs} WHERE app_id=$1 AND collection=$2 AND id>$3${filter} ORDER BY id LIMIT $4`,values);
        return rows.map(row=>({id:row.id,revision:Number(row.revision),value:row.body}));
      }
    };
  }
  return {
    async admit(peer, now, limits) {
      const client=await pool.connect(),window=Math.floor(now/300000);
      try {await client.query('BEGIN');
        await client.query("SET LOCAL statement_timeout='5s'");
        await client.query("SET LOCAL lock_timeout='2s'");
        await client.query("SET LOCAL idle_in_transaction_session_timeout='8s'");
        for(const [id,maximum] of [['global',limits.requestsGlobal],[peer,limits.requestsPerPeer]]) {
          const result=await client.query(`INSERT INTO ${docs}(app_id,collection,id,revision,body) VALUES('__rate__','rate',$1,1,jsonb_build_object('window',$2::bigint,'count',1))
            ON CONFLICT(app_id,collection,id) DO UPDATE SET revision=${docs}.revision+1,body=jsonb_build_object('window',$2::bigint,'count',CASE WHEN (${docs}.body->>'window')::bigint=$2 THEN (${docs}.body->>'count')::bigint+1 ELSE 1 END)
            WHERE (${docs}.body->>'window')::bigint<>$2 OR (${docs}.body->>'count')::bigint<$3 RETURNING id`,[id,window,maximum]);
          requireThat(result.rows.length===1,'rate_limited');
        } await client.query('COMMIT');
      } catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
    },
    reader:appId=>reader(pool,appId),
    async catalog({after='',limit=50}={}) {
      integer(limit,1,100);
      const {rows}=await pool.query(`SELECT app_id FROM ${docs} WHERE app_id>$1 AND collection='meta' AND id='app' ORDER BY app_id LIMIT $2`,[after,limit]);
      return rows.map(r=>r.app_id);
    },
    async transaction(appId,run) {
      text(appId);const client=await pool.connect();let active=true;
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL statement_timeout='10s'");
        await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[schema]);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1))',[schema+':app:'+appId]);
        const tx={...reader(client,appId,true),async write(collection,id,value,expectedRevision) {
          requireThat(active,'transaction_closed');integer(expectedRevision);text(collection);text(id);
          const body=canonical(value);requireThat(Buffer.byteLength(body)<=65536,'document_too_large');
          const {rows}=expectedRevision===0
            ? await client.query(`INSERT INTO ${docs} VALUES($1,$2,$3,1,$4::jsonb) ON CONFLICT DO NOTHING RETURNING revision`,[appId,collection,id,body])
            : await client.query(`UPDATE ${docs} SET revision=revision+1,body=$4::jsonb WHERE app_id=$1 AND collection=$2 AND id=$3 AND revision=$5 RETURNING revision`,[appId,collection,id,body,expectedRevision]);
          requireThat(rows.length===1,'revision_conflict');return {revision:Number(rows[0].revision),value:copy(value)};
        }};
        const result=await run(tx);await client.query('COMMIT');return result;
      } catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}
      finally{active=false;client.release();}
    }
  };
}

// Deterministic isolated adapter for tests. Production always uses PostgreSQL.
export function memoryAppStore(network) {
  const states=new Map(),queues=new Map();
  const reader=rows=>({network,read:async(c,id)=>copy(rows.get(c+'\0'+id)??null),list:async(c,{after='',limit=50,authorId,state,parentId,assigneeId}={})=>
    [...rows].filter(([k,r])=>k.startsWith(c+'\0')&&k.slice(c.length+1)>after&&(authorId===undefined||r.value.authorId===authorId)&&(state===undefined||r.value.state===state)&&(parentId===undefined||r.value.parentId===parentId)&&(assigneeId===undefined||r.value.assigneeId===assigneeId))
      .sort(([a],[b])=>a<b?-1:1).slice(0,limit).map(([k,r])=>({id:k.slice(c.length+1),...copy(r)}))});
  return {reader:id=>reader(states.get(id)??new Map()),catalog:async({after='',limit=50}={})=>[...states.keys()].filter(id=>id>after&&states.get(id).has('meta\0app')).sort().slice(0,limit),
    transaction(id,run){const task=(queues.get(id)??Promise.resolve()).then(async()=>{
      const rows=new Map([...states.get(id)??[]].map(([k,r])=>[k,copy(r)]));
      const tx={...reader(rows),async write(c,key,value,expected){const old=rows.get(c+'\0'+key);requireThat((old?.revision??0)===expected,'revision_conflict');const row={revision:expected+1,value:copy(value)};rows.set(c+'\0'+key,row);return copy(row);}};
      const result=await run(tx);states.set(id,rows);return result;});queues.set(id,task.catch(()=>{}));return task;}
  };
}
