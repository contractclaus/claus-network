import {textWindow,textPrefix} from './text.ts';
import {createHash} from 'node:crypto';
import type {Configuration} from './config.js';
import {searchPage} from './context.js';
import {ecosystemRecords} from './ecosystem.js';
import {workSkillRecords} from './work-skills.js';
import {referenceSourceHash} from './reference.js';
import {knowledgeArchive} from './knowledge-archive.js';
import {sql} from './store.js';

type RecordEntry={id:string;title:string;summary:string;body:string;bodyRef?:{id:string;sha256:string;chars:number};kind:string;status:string;visibility:string;source:string;updatedAt?:string;reviewAfter?:string;relatedRules?:string[];sources?:unknown[];readMore?:unknown};
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const pathOf=(href:string)=>{try{return new URL(href).pathname;}catch{return null;}};
// A projection of settings, not an executor. Keep this dependency-free from
// model/tools and test its advertised tools against the real inference request.
export function runtimeCapabilityView(settings:Configuration['settings'],channel:'public'|'club'='public') {
  const configured={
    siteEditor:settings.siteEditor?.enabled===true,
    siteAutonomy:settings.siteEditor?.autonomyEnabled===true,
    builder:settings.builder?.enabled===true,
    solidity:settings.builder?.solidityEnabled===true,
    adaptation:settings.adaptation?.enabled===true,
    workspaces:settings.workspaces?.enabled===true,
    packages:settings.packages?.enabled===true,
    continuity:settings.continuity?.enabled===true,
    club:settings.club?.enabled===true,
    research:settings.lab?.enabled===true,
    networkOperations:settings.networkOperations?.enabled===true
  };
  const privateChannel=channel==='club';
  const availableTools={
    networkWork:!privateChannel&&configured.networkOperations?['network_work']:[],
    site:configured.siteEditor?['read_site','update_site','undo_site_change',...(configured.siteAutonomy&&configured.builder?['build_site_feature','propose_site_feature']:[])]:[],
    prototypes:configured.builder?['propose_prototype','read_prototype']:[],
    builder:privateChannel&&configured.builder?['create_build','read_builder']:[],
    adaptation:configured.adaptation?['read_adaptation','adapt_behavior','rollback_adaptation']:[],
    contributions:privateChannel&&configured.workspaces&&configured.builder?['read_contributions','review_contribution']:[],
    continuity:privateChannel&&configured.continuity&&configured.club?['read_weekly_recap','publish_weekly_recap']:[],
    club:privateChannel&&configured.club?['read_club','reply_club','react_club','like_club_idea','share_club_idea','open_club_vote','resolve_club','offer_club_idea','manage_club']:[]
  };
  return {
    channel,configured,availableTools,
    executionEnabled:settings.enabled===true,
    solidityExecutionEnabled:settings.enabled===true&&configured.builder&&configured.solidity,
    scope:'Configured availability and channel tool exposure, not execution success or a new grant. The twitter role can include explicitly enabled bounded website, prototype and typed-adaptation tools. Exposed schemas may remain while global execution is paused. Each action still requires its service controls, source eligibility, access checks, revisions and budgets. Workspace/package flags describe services, not public access to private projects or model permission to publish packages. Confirm outcomes with actual receipts; queued, tested, reviewed and published are distinct states. Fixed identity and owner rules are unchanged; no arbitrary code deployment, wallet/contract administration or self-granted permissions. This capability view contains no Club source or private runtime state.'
  };
}

export function knowledgeRecords(config:Configuration,published:any,channel:'public'|'club'='public'):RecordEntry[] {
  return [
    ...knowledgeArchive,
    ...ecosystemRecords(),
    ...workSkillRecords(),
    ...(config.knowledge?.topics??[]).filter(t=>!(channel==='club'&&t.bodyRef&&t.visibility==='internal')).map(t=>({...t,id:'topic:'+t.id,kind:'topic',source:'live_configuration'})),
    ...config.policy.rules.filter(r=>r.enabled).map(r=>({id:'rule:'+r.id,title:r.id,summary:'Current owner rule',body:r.text,kind:'rule',status:'enabled',visibility:'internal',source:'live_configuration'})),
    {id:'runtime:current',title:'Current runtime and authority',summary:'Configured bounded capabilities and channel tools; not execution evidence',body:JSON.stringify({model:config.settings.model,provider:config.settings.provider,reasoningEffort:config.settings.reasoningEffort,role:config.settings.role,enabled:config.settings.enabled,capabilities:Object.fromEntries(['research','memory','drafts','club','xRead','xReply','xPublish','images','chainWrite','externalTransfer','sandbox','publicPublish','networkBuild','workPayments','networkReview','networkDealReview'].map(key=>[key,config.policy.capabilities[key]===true])),bounded:runtimeCapabilityView(config.settings,channel)},null,2),kind:'runtime',status:'current',visibility:'internal',source:'live_configuration'},
    {id:'publication:token',title:'Published token and installed hook',summary:'Current editorial record, not a fresh chain observation',body:JSON.stringify({token:published.token,hook:published.hook,observation:published.observation},null,2),kind:'publication',status:'published',visibility:'public',source:'current_publication',updatedAt:published.updatedAt},
    ...(published.functions??[]).map((f:any)=>({id:'hook:'+(pathOf(f.href)??f.name),title:f.name,summary:'Active in the current publication',body:f.description,kind:'hook',status:'published',visibility:'public',source:'current_publication',updatedAt:published.updatedAt,readMore:{tool:'read_publication'},sources:[{kind:'url',ref:f.href}]})),
    ...(published.logs??[]).map((j:any)=>({id:'journal:'+j.id,title:j.title,summary:j.summary??'',body:j.summary??'',kind:'journal',status:'historical',visibility:'public',source:'current_publication',updatedAt:j.at,readMore:{tool:'read_publication',entryId:j.id,contentScope:'summary_only'}}))
  ];
}

type KnowledgeArgs={id?:string;query?:string;kind?:string;offset?:number;limit?:number;version?:string};
export function readKnowledge(args:KnowledgeArgs,config:Configuration,published:any,channel:'public'|'club'='public',hydrated?:RecordEntry[]) {
  const canonical=knowledgeRecords(config,published,channel),records=hydrated??canonical,version=hash(canonical),offset=args.offset??0,limit=args.limit??12000;
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1000||limit>24000)throw Error('invalid_knowledge_page');
  if(args.id!==undefined&&(typeof args.id!=='string'||args.query!==undefined||args.kind!==undefined))throw Error('knowledge_id_or_search_required');
  if(args.query!==undefined&&(typeof args.query!=='string'||args.query.length>240))throw Error('invalid_knowledge_query');
  if(args.kind!==undefined&&!['topic','rule','runtime','publication','hook','journal','account','skill'].includes(args.kind))throw Error('invalid_knowledge_kind');
  if(args.version!==undefined&&args.version!==version)throw Error('knowledge_changed_restart_read');
  const meta={version,configurationRevision:(config as Configuration&{revision?:number}).revision,publicationRevision:published.revision??null,instructionAuthority:false};
  if(args.id!==undefined) {
    const record=records.find(r=>r.id===args.id);
    if(!record)throw Error('knowledge_record_not_found');
    const {body,...info}=record,page=textWindow(body,offset,limit);
    return {...meta,record:{...info,body:page.content},offset:page.offset,nextOffset:page.nextOffset,totalChars:body.length,offsetUnit:'characters'};
  }
  const terms=(args.query??'').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_]+/gu)??[];
  const matched=records.filter(r=>!args.kind||r.kind===args.kind).map(r=>{
    const title=(r.id+' '+r.title+' '+r.summary).toLowerCase(),all=(title+' '+r.body).toLowerCase();
    return {r,score:terms.every(t=>all.includes(t))?terms.reduce((n,t)=>n+(title.includes(t)?3:1),0):-1};
  }).filter(x=>x.score>=0).sort((a,b)=>b.score-a.score||a.r.id.localeCompare(b.r.id)).map(x=>x.r);
  const candidates=matched.slice(offset,offset+21).map(r=>({id:r.id,title:r.title,summary:textPrefix(r.summary,240),kind:r.kind,status:r.status,visibility:r.visibility,source:r.source,reviewAfter:r.reviewAfter,totalChars:r.bodyRef?.chars??r.body.length}));
  return {...meta,...searchPage(candidates,offset,20),totalRecords:matched.length,offsetUnit:'records',readMore:'Read an exact id for its complete body and source references. Pass version and nextOffset to continue this snapshot. No matches means not found here, not proof that a fact is false.'};
}

export function pinnedKnowledgeBody(record:RecordEntry,row:any,channel:'public'|'club') {
  const ref=record.bodyRef;
  if(!ref||!row||row.id!==ref.id||typeof row.body!=='string'||row.body.length!==ref.chars
    ||createHash('sha256').update(row.body).digest('hex')!==ref.sha256
    ||record.visibility==='public'&&row.visibility!=='public'
    ||record.visibility==='internal'&&(channel==='club'||row.visibility!=='private_network'))throw Error('knowledge_source_unavailable');
  return row.body as string;
}

// The catalogue stays small. Exact reads and searches hydrate only the pinned
// bodies needed for that request; mutable/latest memories are never substituted.
export async function readKnowledgeResolved(args:KnowledgeArgs,config:Configuration,published:any,channel:'public'|'club'='public',db=sql()) {
  const records=knowledgeRecords(config,published,channel);
  const needed=records.filter(r=>r.bodyRef&&(args.id?r.id===args.id:!args.kind||r.kind===args.kind));
  if((!args.id&&!args.query?.trim())||!needed.length)return readKnowledge(args,config,published,channel);
  // Check the snapshot and query shape before I/O. Exact pagination must be
  // applied to the full body below, not to the shorter inline summary.
  readKnowledge({...args,offset:args.id?0:args.offset},config,published,channel);
  const ids=needed.map(r=>r.bodyRef!.id);
  const rows=await db`SELECT id,body,visibility FROM claus_memories WHERE id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))
    AND (visibility='public' OR visibility='private_network' AND ${channel}='public')`;
  const bodies=new Map(needed.map(record=>[record.id,pinnedKnowledgeBody(record,rows.find((row:any)=>row.id===record.bodyRef!.id),channel)]));
  return readKnowledge(args,config,published,channel,records.map(r=>bodies.has(r.id)?{...r,body:bodies.get(r.id)!}:r));
}

// Structural checks name their exact scope. They do not certify arbitrary prose.
export function knowledgeAudit(config:Configuration,published:any,now=Date.now()) {
  const topics=config.knowledge?.topics??[],issues:{code:string;record:string;action:string}[]=[];
  if(!config.knowledge)issues.push({code:'legacy_unstructured_facts',record:'identity',action:'Move durable facts into stable knowledge topics.'});
  if(config.identity.length>18000)issues.push({code:'identity_near_limit',record:'identity',action:'Separate project facts from character and behavior.'});
  const activeRules=new Set(config.policy.rules.filter(r=>r.enabled).map(r=>r.id)),bodies=new Map<string,string>();
  for(const t of topics) {
    for(const s of t.sources)if(s.kind==='reference'&&s.sha256&&referenceSourceHash(s.ref)!==s.sha256)issues.push({code:'reference_version_mismatch',record:'topic:'+t.id,action:'Reconcile '+s.ref+' with the verified knowledge source version.'});
    if(t.reviewAfter&&Date.parse(t.reviewAfter)<=now)issues.push({code:'review_due',record:'topic:'+t.id,action:'Verify the named source before asserting its current status. Keep the dated evidence until then.'});
    for(const id of t.relatedRules)if(!activeRules.has(id))issues.push({code:'missing_active_rule',record:'topic:'+t.id,action:'Reconcile linked rule '+id});
    // A pinned topic's inline text is only its preview. Historical topics may
    // share that preview while retaining different immutable full bodies.
    if(t.body){const key=t.bodyRef?.sha256??createHash('sha256').update(t.body).digest('hex');if(bodies.has(key))issues.push({code:'duplicate_fact_body',record:'topic:'+t.id,action:'Use one source; same full body as '+bodies.get(key)});bodies.set(key,t.id);}
    if(t.status==='current'&&t.hookStatus!=='retired')for(const p of t.hookPaths)if(!(published.functions??[]).some((f:any)=>pathOf(f.href)===p))issues.push({code:'hook_not_in_publication',record:'topic:'+t.id,action:'Reconcile '+p+' with the current publication; do not assume it is live.'});
  }
  for(const f of published.functions??[])if(!topics.some(t=>t.status==='current'&&t.hookStatus!=='retired'&&t.hookPaths.includes(pathOf(f.href)??'')))issues.push({code:'hook_without_topic',record:'hook:'+(pathOf(f.href)??f.name),action:'Add its facts, sources, limits and related rules to a current topic.'});
  return {schemaVersion:1,topicCount:topics.length,enabledRuleCount:activeRules.size,publishedHookCount:(published.functions??[]).length,identityChars:config.identity.length,issues,scope:'Schema, source metadata, duplicate bodies, linked rules, review dates and published-hook coverage. Semantic truth and live balances still require source verification.'};
}
