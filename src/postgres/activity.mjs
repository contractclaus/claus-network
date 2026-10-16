import {integer,requireThat} from '../shared/index.mjs';

const taskTypes="'task.posted','task.claim','task.deliver','task.accept','task.cancel','task.agreement'";
const networkTypes="'project.published','release.published','release.restored'";
const quoted=s=>{requireThat(/^[a-z][a-z0-9_]{0,47}$/.test(s),'invalid_schema');return '"'+s+'"';};

export function activityIndexes(schema,{concurrently=true}={}) {
  const s=quoted(schema),c=concurrently?'CONCURRENTLY ':'';
  return [
    `CREATE INDEX ${c}IF NOT EXISTS network_activity_recent ON ${s}.events(sequence DESC) WHERE body->>'type' IN (${networkTypes})`,
    `CREATE INDEX ${c}IF NOT EXISTS app_activity_recent ON ${s}.app_documents(((body->>'at')::bigint) DESC,app_id,id) WHERE collection='events' AND body->>'collection'='tasks' AND body->>'type' IN (${taskTypes})`
  ];
}

// Query original records. The bounded candidate windows are not a replicated
// feed, and every row is checked against its current publication/privacy state.
export function publicActivityQuery(schema,{limit=40,at,includeTasks=true}) {
  integer(limit,1,100);integer(at);const s=quoted(schema),d=s+'.documents',a=s+'.app_documents';
  const tasks=includeTasks?`
    UNION ALL SELECT e.app_id||':event:'||(e.body->>'sequence') AS id,e.app_id AS project_id,
      e.body->>'type' AS kind,(e.body->>'at')::bigint AS at,e.body->>'id' AS task_id,NULL::text AS release_id
    FROM (SELECT app_id,id,body FROM ${a} WHERE collection='events' AND body->>'collection'='tasks'
      AND body->>'type' IN (${taskTypes}) ORDER BY (body->>'at')::bigint DESC,app_id,id LIMIT 400) e
    JOIN ${a} app ON app.app_id=e.app_id AND app.collection='meta' AND app.id='app'
      AND app.body->>'published'='true' AND app.body->'manifest'->'tasks'->>'visibility'='public'
    JOIN ${a} task ON task.app_id=e.app_id AND task.collection='tasks' AND task.id=e.body->>'id'
      AND coalesce(task.body->>'hidden','false')='false'
    JOIN ${a} version ON version.app_id=e.app_id AND version.collection='versions' AND version.id=task.body->>'version'
      AND version.body->'manifest'->'tasks'->>'visibility'='public'`:'';
  return {sql:`WITH candidates AS (
    SELECT 'network:'||e.sequence AS id,e.body->>'projectId' AS project_id,
      CASE WHEN e.body->>'type'='project.published' THEN 'project.updated' ELSE 'interface.created' END AS kind,
      (e.body->>'at')::bigint AS at,NULL::text AS task_id,e.body->>'releaseId' AS release_id
    FROM (SELECT sequence,body FROM ${s}.events WHERE body->>'type' IN (${networkTypes}) ORDER BY sequence DESC LIMIT 400) e
    ${tasks}
  ) SELECT e.id,e.project_id,e.kind,e.at,e.task_id,pub.body->>'name' AS name,pub.id AS slug
    FROM candidates e
    JOIN ${d} p ON p.collection='projects' AND p.id=e.project_id AND p.body->>'id'=p.id
      AND p.body->>'archivedAt' IS NULL AND p.body->>'transfer' IS NULL
    JOIN ${d} pub ON pub.collection='public-projects' AND pub.id=p.body->>'slug'
      AND pub.body->>'projectId'=p.id AND pub.body->>'slug'=pub.id AND pub.body->>'published'='true'
    LEFT JOIN ${d} publication ON publication.collection='release-publications' AND publication.id=e.release_id
    LEFT JOIN ${d} release ON release.collection='project-releases' AND release.id=e.release_id
    WHERE e.at>0 AND e.at<=$1
      AND NOT EXISTS (SELECT 1 FROM ${d} h WHERE h.collection='content-controls' AND h.id=p.id AND h.body->>'held'='true')
      AND (e.kind<>'interface.created' OR (publication.body->>'published'='true'
        AND publication.body->>'projectId'=p.id AND release.body->>'projectId'=p.id
        AND (publication.body->>'expiresAt' IS NULL OR (publication.body->>'expiresAt')::bigint>$1)))
    ORDER BY e.at DESC,e.id DESC LIMIT $2`,params:[at,limit]};
}

export function publicActivityResponse(rows,{at,includeTasks=true}) {
  return {observedAt:at,complete:false,coverage:'Recent published project and release events'+(includeTasks?' and public task events':'')+'; bounded to 400 original events per source. Current visibility rechecked.',
    events:rows.map(r=>({id:r.id,projectId:r.project_id,project:r.name,href:'/c/'+r.slug,kind:r.kind,at:Number(r.at),...(r.task_id?{taskId:r.task_id}:{})}))};
}
