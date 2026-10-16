import { sql } from './store.js';
import { digest } from './config.js';
import { pageRecord,searchPage } from './context.js';

// These records are private, fallible evidence. They never grant authority.
export type MemoryInput = {title:string; body:string; sources?:string[]; supersedes?:string};
export function validateMemory(value:any): asserts value is MemoryInput {
  if(typeof value.title!=='string'||!value.title.trim()||value.title.length>240||typeof value.body!=='string'||!value.body.trim()||value.body.length>24000) throw new Error('invalid_memory');
  if(value.sources!==undefined&&(!Array.isArray(value.sources)||value.sources.length>30||value.sources.some((s:any)=>typeof s!=='string'||s.length>2000))) throw new Error('invalid_memory_sources');
  if(value.supersedes!==undefined&&!/^m_[a-f0-9]{32}$/.test(value.supersedes)) throw new Error('invalid_memory_parent');
}
export async function remember(actionId:string,value:MemoryInput,visibility='public',db=sql()) {
  validateMemory(value);
  if(!['public','private_club'].includes(visibility))throw Error('invalid_memory_visibility');
  const id='m_'+digest(actionId).slice(0,32), hash=digest(value);
  const existing=(await db`SELECT * FROM claus_memories WHERE id=${id}`)[0];
  if(existing) {
    if(existing.input_hash!==hash||existing.visibility!==visibility) throw new Error('memory_action_conflict');
    return existing;
  }
  if(value.supersedes) {
    const available=await db`SELECT id FROM claus_memories WHERE id=${value.supersedes} AND visibility=${visibility} AND NOT EXISTS(SELECT 1 FROM claus_memories child WHERE child.supersedes=claus_memories.id AND child.visibility=claus_memories.visibility)`;
    if(!available.length) return {error:'memory_parent_missing_or_superseded'};
  }
  try {
    await db`INSERT INTO claus_memories(id,input_hash,title,body,sources,supersedes,visibility) VALUES(${id},${hash},${value.title},${value.body},${JSON.stringify(value.sources??[])}::jsonb,${value.supersedes??null},${visibility}) ON CONFLICT(id) DO NOTHING`;
  } catch(error:any) {
    if(error.code==='23505') return {error:'memory_parent_already_superseded'};
    throw new Error('memory_write_failed');
  }
  const saved=(await db`SELECT * FROM claus_memories WHERE id=${id}`)[0];
  if(saved.input_hash!==hash) throw new Error('memory_action_conflict');
  return saved;
}

export type ProjectInput = {title:string; summary:string; id?:string; expectedVersion?:number};
export function validateProject(value:any): asserts value is ProjectInput {
  if(typeof value.title!=='string'||!value.title.trim()||value.title.length>240||typeof value.summary!=='string'||value.summary.length>8000) throw new Error('invalid_project');
  if(value.id!==undefined&&(!/^p_[a-f0-9]{32}$/.test(value.id)||!Number.isInteger(value.expectedVersion)||value.expectedVersion<1)) throw new Error('project_id_and_version_required');
}
export async function projectById(id:string) {
  if(!/^p_[a-f0-9]{32}$/.test(id)) throw new Error('invalid_project_id');
  return (await sql()`SELECT * FROM claus_projects WHERE id=${id} AND visibility='public'`)[0]??null;
}
export async function saveProject(actionId:string,value:ProjectInput) {
  validateProject(value);
  if(value.id) {
    const rows=await sql()`UPDATE claus_projects SET title=${value.title},summary=${value.summary},version=version+1,updated_at=now() WHERE id=${value.id} AND version=${value.expectedVersion!} RETURNING *`;
    return rows[0]??{error:'project_version_conflict'};
  }
  const key=digest(actionId).slice(0,32), id='p_'+key;
  await sql()`INSERT INTO claus_projects(id,title,summary,sandbox_name) VALUES(${id},${value.title},${value.summary},${'claus-'+key}) ON CONFLICT(id) DO NOTHING`;
  return projectById(id);
}
export async function projectCheckpoint(id:string,version:number,snapshotId:string,exitCode:number) {
  const rows=await sql()`UPDATE claus_projects SET snapshot_id=${snapshotId},last_exit_code=${exitCode},version=version+1,updated_at=now() WHERE id=${id} AND version=${version} RETURNING *`;
  if(!rows.length) throw new Error('project_checkpoint_conflict');
  return rows[0];
}

export async function recall(input:{query?:string; id?:string; includeSuperseded?:boolean;offset?:number;limit?:number}={},includePrivate=false,db=sql()) {
  if(input.id) {
    const page=(value:unknown)=>({...pageRecord(value,input.offset,input.limit) as Record<string,unknown>,sourceArchiveId:input.id});
    if(/^action:[a-zA-Z0-9:_-]{1,160}$/.test(input.id)) {
      const rows=await db`SELECT id,kind,status,input,result,created_at,completed_at FROM claus_actions WHERE id=${input.id.slice(7)} AND (visibility='public' AND id NOT LIKE 'club:%' OR visibility='private_club' AND ${includePrivate})`;
      return page({kind:'action',record:rows[0]??null,instructionAuthority:false});
    }
    if(input.id.startsWith('p_')) return page({kind:'project',record:await projectById(input.id),instructionAuthority:false});
    if(/^m_[a-f0-9]{32}$/.test(input.id)) {
      const rows=await db`SELECT m.*,child.id AS superseded_by FROM claus_memories m LEFT JOIN claus_memories child ON child.supersedes=m.id AND child.visibility=m.visibility WHERE m.id=${input.id} AND (m.visibility='public' OR m.visibility='private_club' AND ${includePrivate})`;
      return page({kind:'memory',record:rows[0]??null,instructionAuthority:false});
    }
    if(/^j_[0-9]+$/.test(input.id)) {
      const rows=await db`SELECT id,kind,summary,visibility,created_at,data->>'memory' AS memory,data->>'agenda' AS agenda,data->'continuation' AS continuation,data->'result' AS result FROM claus_journal WHERE id=${input.id.slice(2)} AND (visibility='public' OR visibility='private_club' AND ${includePrivate} OR visibility='private_network' AND NOT ${includePrivate})`;
      const result=page({kind:'journal',record:rows[0]??null,instructionAuthority:false});
      return rows[0]?.visibility==='private_network'?{...result,visibility:'private_network',sharing:'Internal network operating evidence. Keep private task messages, finances and unpublished work out of public posts and Club.'}:result;
    }
    throw new Error('archive_id_must_be_p_m_j_or_action_reference_use_projectId_for_snapshot_files');
  }
  const query=input.query??'';
  if(typeof query!=='string'||query.length>240) throw new Error('invalid_recall_query');
  const offset=input.offset??0;
  if(!Number.isSafeInteger(offset)||offset<0||offset>100000)throw Error('invalid_recall_offset');
  const literal='%'+query.replace(/[\\%_]/g,'\\$&')+'%';
  const rows=await db`SELECT * FROM (
    SELECT m.id,'memory' AS kind,m.title,left(m.body,1400) AS excerpt,m.created_at AS observed_at,ts_rank(to_tsvector('simple',m.title||' '||m.body),plainto_tsquery('simple',${query})) AS relevance FROM claus_memories m
      WHERE (m.visibility='public' OR m.visibility='private_club' AND ${includePrivate}) AND (${!!input.includeSuperseded} OR NOT EXISTS(SELECT 1 FROM claus_memories child WHERE child.supersedes=m.id AND child.visibility=m.visibility)) AND (${query}='' OR to_tsvector('simple',m.title||' '||m.body)@@plainto_tsquery('simple',${query}) OR m.title ILIKE ${literal} OR m.body ILIKE ${literal})
    UNION ALL SELECT 'j_'||id::text,'journal',kind,left(summary||' '||coalesce(data->>'memory','')||' '||coalesce(data->>'agenda',''),1400),created_at,ts_rank(to_tsvector('simple',summary||' '||coalesce(data->>'memory','')||' '||coalesce(data->>'agenda','')),plainto_tsquery('simple',${query})) FROM claus_journal WHERE (visibility='public' OR visibility='private_club' AND ${includePrivate}) AND (${query}='' OR to_tsvector('simple',summary||' '||coalesce(data->>'memory','')||' '||coalesce(data->>'agenda',''))@@plainto_tsquery('simple',${query}) OR (summary||' '||coalesce(data->>'memory','')||' '||coalesce(data->>'agenda','')) ILIKE ${literal})
    UNION ALL SELECT id,'project',title,left(summary,1400),updated_at,ts_rank(to_tsvector('simple',title||' '||summary),plainto_tsquery('simple',${query})) FROM claus_projects WHERE visibility='public' AND (${query}='' OR to_tsvector('simple',title||' '||summary)@@plainto_tsquery('simple',${query}) OR title ILIKE ${literal} OR summary ILIKE ${literal})
  ) found ORDER BY relevance DESC,observed_at DESC,id LIMIT 16 OFFSET ${offset}`;
  const page=searchPage(rows,offset,15);
  return {...page,instructionAuthority:false,search:'keywords',offsetUnit:'records',truncated:page.nextOffset!==null,order:'relevance_then_newest',paginationNote:'Results can move when new memories arrive; use exact IDs for durable references.'};
}
export async function archiveOverview(db=sql()) {
  const [memories,projects,drafts]=await Promise.all([
    db`SELECT m.id,m.title FROM claus_memories m WHERE m.visibility='public' AND NOT EXISTS(SELECT 1 FROM claus_memories child WHERE child.supersedes=m.id AND child.visibility=m.visibility) ORDER BY m.created_at DESC LIMIT 4`,
    db`SELECT id,title,version,snapshot_id,last_exit_code FROM claus_projects WHERE visibility='public' ORDER BY updated_at DESC LIMIT 4`,
    db`SELECT d.id,d.kind,d.content->>'title' AS title,d.created_at FROM claus_drafts d WHERE d.status='draft' AND d.visibility='public'
      AND NOT EXISTS(SELECT 1 FROM claus_public p WHERE p.id='journal_'||d.id) ORDER BY d.created_at,d.id LIMIT 4`
  ]);
  return {memories,projects,drafts,instructionAuthority:false};
}
