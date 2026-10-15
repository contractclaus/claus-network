import {integer,requireThat} from '../shared/index.mjs';

// Match only public profile fields, never private project/credential documents.
// The same expression is used by the index and query; no replicated directory.
const fields=['name','description','slug','projectId','agentId'];
const expression=alias=>'lower('+fields.map(f=>`coalesce(${alias}body->>'${f}','')`).join("||E'\\n'||")+')';
const schemaName=s=>{requireThat(/^[a-z][a-z0-9_]{0,47}$/.test(s),'invalid_schema');return '"'+s+'"';};
export function directoryIndexMigration(schema,{concurrently=true}={}) {
  return `CREATE INDEX ${concurrently?'CONCURRENTLY ':''}IF NOT EXISTS documents_public_search ON ${schemaName(schema)}.documents USING gin ((${expression('')}) public.gin_trgm_ops) WHERE collection IN ('public-projects','project-public-agents') AND body->>'published'='true'`;
}
export function publicDirectoryQuery(schema,{kind,query='',after='',limit=20}) {
  requireThat(['project','agent'].includes(kind),'invalid_discovery_kind');integer(limit,1,25);
  requireThat(typeof query==='string'&&query.length<=120&&typeof after==='string'&&after.length<=2048,'invalid_query');
  const table=schemaName(schema)+'.documents',collection=kind==='project'?'public-projects':'project-public-agents';
  // Escaping makes %, _ and backslash literal, not an unbounded pattern language.
  const pattern='%'+query.trim().replace(/[\\%_]/g,'\\$&')+'%';
  return {sql:`SELECT d.id,d.revision,d.body,p.body->>'slug' AS slug,
    EXISTS (SELECT 1 FROM ${table} w WHERE w.collection='agent-work-profiles' AND w.id=(p.id||':'||(d.body->>'agentId')) AND w.body->>'published'='true' AND p.body->>'transfer' IS NULL) AS portfolio FROM ${table} d
    JOIN ${table} p ON p.collection='projects' AND p.id=d.body->>'projectId' AND p.body->>'id'=p.id
    JOIN ${table} pub ON pub.collection='public-projects' AND pub.id=p.body->>'slug' AND pub.body->>'projectId'=p.id AND pub.body->>'published'='true'
    WHERE d.collection='${collection}' AND d.body->>'published'='true' AND d.id>$1
      AND p.body->>'archivedAt' IS NULL
      ${kind==='project'?"AND d.id=pub.id AND d.body->>'slug'=pub.id":''}
      AND NOT EXISTS (SELECT 1 FROM ${table} h WHERE h.collection='content-controls' AND h.id=p.id AND h.body->>'held'='true')
      AND ${expression('d.')} LIKE lower($2) ESCAPE E'\\\\'
    ORDER BY d.id LIMIT $3`,params:[after,pattern,limit+1]};
}
