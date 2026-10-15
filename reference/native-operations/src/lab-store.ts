import {managedDatabase,managedSchemaReady} from './database-schema.js';
import {textPrefix} from './text.ts';
import type {LabDatabase,LabQuery} from './lab-db.js';
import {commitmentAmount,type ModelCommitment} from './lab-accounting.js';
import {hash,text,identifier,publicUrl,iso,projectIdea,proposalCandidate,ideaOrganization,mergeIdeaOrganization,type Idea,type IdeaStatus,type Evidence,type Effect,type LabActor,type LabSettings,type PublicEvent,type PublicProposal} from './lab-schema.js';

// Research has its own leases, effects and outbox. An uncertain research payment
// must never enter the X publisher's global unresolved-action queue.
export class LabStore {
  constructor(readonly db:LabDatabase,readonly now=()=>new Date(),private fence?:{ideaId:string;owner:string}){}
  fenced(ideaId:string,owner:string){return new LabStore(this.db,this.now,{ideaId,owner});}
  async assertLease(){if(this.fence)await this.db.transaction(q=>this.lock(q));}
  async initialize(){if(managedDatabase())return managedSchemaReady();
    await this.db.query(`CREATE TABLE IF NOT EXISTS claus_lab_ideas(id text PRIMARY KEY, revision integer NOT NULL, status text NOT NULL, visibility text NOT NULL, content jsonb NOT NULL, steps integer NOT NULL DEFAULT 0, next_at timestamptz NOT NULL, lease_owner text, lease_until timestamptz, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS claus_lab_events(seq bigserial PRIMARY KEY, event_key text UNIQUE NOT NULL, digest text NOT NULL, idea_id text NOT NULL REFERENCES claus_lab_ideas(id), revision integer NOT NULL, content jsonb NOT NULL, created_at timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS claus_lab_evidence(id text PRIMARY KEY, idea_id text NOT NULL REFERENCES claus_lab_ideas(id), revision integer NOT NULL, content jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS claus_lab_effects(id text PRIMARY KEY, idea_id text NOT NULL REFERENCES claus_lab_ideas(id), revision integer NOT NULL, kind text NOT NULL, status text NOT NULL, input_hash text NOT NULL, input jsonb NOT NULL, result jsonb, private_data jsonb, amount numeric(40,0) NOT NULL, currency text NOT NULL, period text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
      ALTER TABLE claus_lab_effects ADD COLUMN IF NOT EXISTS accounted_amount numeric(40,0) CHECK(accounted_amount>0 AND accounted_amount<=amount);
      CREATE TABLE IF NOT EXISTS claus_lab_notes(id text PRIMARY KEY, idea_id text NOT NULL REFERENCES claus_lab_ideas(id), revision integer NOT NULL, content jsonb NOT NULL, deleted boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS claus_lab_note_history(id bigserial PRIMARY KEY, note_id text NOT NULL, revision integer NOT NULL, content jsonb NOT NULL, deleted boolean NOT NULL, created_at timestamptz NOT NULL, UNIQUE(note_id,revision));
      CREATE TABLE IF NOT EXISTS claus_lab_runtime(id integer PRIMARY KEY, content jsonb NOT NULL, updated_at timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS claus_lab_runner(id integer PRIMARY KEY, generation integer NOT NULL, state text NOT NULL, turn_after timestamptz NOT NULL, deadline timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS claus_research_cache(id text PRIMARY KEY,result jsonb,next_at timestamptz NOT NULL,error text);
      CREATE TABLE IF NOT EXISTS claus_research_reads(id bigserial PRIMARY KEY,kind text NOT NULL,created_at timestamptz NOT NULL);
      CREATE INDEX IF NOT EXISTS claus_research_read_limits ON claus_research_reads(kind,created_at);
      CREATE TABLE IF NOT EXISTS claus_development_baselines(id text PRIMARY KEY,seen jsonb NOT NULL,started_at timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS claus_development_updates(id text PRIMARY KEY,content jsonb NOT NULL,created_at timestamptz NOT NULL,captured boolean NOT NULL DEFAULT false);
      CREATE INDEX IF NOT EXISTS claus_lab_work ON claus_lab_ideas(status,next_at);
      CREATE INDEX IF NOT EXISTS claus_lab_feed ON claus_lab_events(idea_id,seq);
      CREATE INDEX IF NOT EXISTS claus_lab_pending ON claus_lab_effects(status,currency,period);`);
  }
  private async lock(q:LabQuery){
    await q.query('SELECT pg_advisory_xact_lock(7439093)');
    if(this.fence){const {rows:[r]}=await q.query('SELECT lease_owner,lease_until FROM claus_lab_ideas WHERE id=$1',[this.fence.ideaId]);
      if(!r||r.lease_owner!==this.fence.owner||new Date(r.lease_until).getTime()<=this.now().getTime())throw Error('lab_lease_lost');
    }
  }
  private ideaRow(r:any):Idea{return {id:r.id,...r.content,revision:r.revision,status:r.status,visibility:r.visibility,steps:r.steps,nextAt:iso(r.next_at),leaseOwner:r.lease_owner,leaseUntil:r.lease_until?iso(r.lease_until):null,createdAt:iso(r.created_at),updatedAt:iso(r.updated_at)};}
  async idea(id:string,q:LabQuery=this.db):Promise<Idea|null>{const {rows:[r]}=await q.query('SELECT * FROM claus_lab_ideas WHERE id=$1',[identifier(id)]);return r?this.ideaRow(r):null;}
  async stepUsage(id:string,settings:LabSettings,q:LabQuery=this.db){
    const idea=await this.idea(id,q);if(!idea)throw Error('lab_idea_missing');
    const {rows:[r]}=await q.query(`SELECT count(*)::int AS exempt FROM claus_lab_effects
      WHERE idea_id=$1 AND kind='model' AND
      ((status='failed' AND result->>'reason' IN ('request_proven_unpaid','inference_funding_required'))
       OR input->>'reviewRefresh'='true')`,[id]);
    // Keep the original attempt counter and every financial effect. A proven
    // unpaid attempt is not completed research; unknown/paid failures still count.
    const used=Math.max(0,idea.steps-r.exempt);
    return {attempts:idea.steps,used,remaining:Math.max(0,settings.maxStepsPerIdea-used)};
  }
  async maintainQueue(settings:LabSettings,factsHash:string){
    if(!settings.enabled||!settings.autonomous)return;
    await this.db.transaction(async q=>{await this.lock(q);
      const {rows}=await q.query(`SELECT * FROM claus_lab_ideas i WHERE visibility='public'
        AND (lease_until IS NULL OR lease_until<$1)
        AND NOT EXISTS(SELECT 1 FROM claus_lab_effects e WHERE e.idea_id=i.id AND e.status IN ('reserved','started','uncertain'))
        AND ((status='blocked' AND content->>'nextStep'='Research allowance reached; review the current findings.')
          OR (status='ready' AND content->'proposal'->>'status' IN ('pending','approved')
              AND content->'proposal'->'review'->>'factsHash' IS DISTINCT FROM $2)
          OR (status='blocked' AND content->'proposal'->>'status'='stale'
              AND EXISTS(SELECT 1 FROM claus_lab_effects e WHERE e.idea_id=i.id AND e.input->>'reviewRefresh'='true')
              AND NOT EXISTS(SELECT 1 FROM claus_lab_effects e WHERE e.idea_id=i.id
                  AND e.input->>'reviewRefresh'='true' AND e.input->'reviewBinding'->>'factsHash'=$2)
              AND NOT EXISTS(SELECT 1 FROM claus_lab_events e WHERE e.idea_id=i.id
                  AND e.event_key=i.id||':facts-review:'||(i.content->'proposal'->>'revision')||':'||$2)))
        ORDER BY updated_at LIMIT 100`,[this.now(),factsHash]);
      for(const row of rows){const idea=this.ideaRow(row);
        if(idea.status==='blocked'&&idea.nextStep==='Research allowance reached; review the current findings.'){
          if(!(await this.stepUsage(idea.id,settings,q)).remaining)continue;
          const message='Continuing saved research; reconciled unpaid model attempts do not consume research steps.';
          // Backlog admission still uses maxActiveIdeas; recovery does not
          // activate every stranded dossier at once.
          await q.query("UPDATE claus_lab_ideas SET status='noted',content=jsonb_set(content,'{nextStep}',$2::jsonb),next_at=$3,updated_at=$3 WHERE id=$1",[idea.id,JSON.stringify(message),this.now()]);
          await this.event(q,`${idea.id}:step-accounting:${idea.steps}`,idea,'research_resumed','system','Research resumed',message);
        }else if(idea.proposal){
          const message='Current project facts changed. Rechecking the saved proposal against its sources.';
          await q.query("UPDATE claus_lab_ideas SET status='noted',content=jsonb_set(jsonb_set(content,'{proposal}',$2::jsonb),'{nextStep}',$3::jsonb),next_at=$4,updated_at=$4 WHERE id=$1",[idea.id,JSON.stringify({...idea.proposal,status:'stale'}),JSON.stringify(message),this.now()]);
          await this.event(q,`${idea.id}:facts-review:${idea.proposal.revision}:${factsHash}`,idea,'review_queued','system','Proposal review queued',message);
        }
      }
    });
  }
  private async require(q:LabQuery,id:string,revision:number){const r=await this.idea(id,q);if(!r)throw Error('lab_idea_missing');if(r.revision!==revision)throw Error('lab_revision_conflict');return r;}
  private async event(q:LabQuery,key:string,idea:Idea,kind:string,actor:LabActor,title:string,summary:string,evidenceIds:string[]=[],sources:{label:string;url:string}[]=[],noteId?:string,noteRevision?:number){
    const content={kind,actor,title:text(title,160),summary:text(summary,6000),evidenceIds,sources:sources.map(s=>({label:text(s.label,160),url:publicUrl(s.url)})),occurredAt:this.now().toISOString(),...(noteId?{noteId,noteRevision}:{})};
    const digest=hash({idea:idea.id,revision:idea.revision,...content,occurredAt:undefined});
    const {rows:[old]}=await q.query('SELECT digest FROM claus_lab_events WHERE event_key=$1',[key]);
    if(old){if(old.digest!==digest)throw Error('lab_event_conflict');return;}
    await q.query('INSERT INTO claus_lab_events(event_key,digest,idea_id,revision,content,created_at) VALUES($1,$2,$3,$4,$5,$6)',[key,digest,idea.id,idea.revision,content,this.now()]);
  }
  private async invalidateProposal(q:LabQuery,idea:Idea){
    if(!idea.proposal||!['pending','approved'].includes(idea.proposal.status))return;
    await q.query("UPDATE claus_lab_ideas SET status='reviewing',content=jsonb_set(jsonb_set(content,'{proposal}',$2::jsonb),'{nextStep}',$3::jsonb),updated_at=$4 WHERE id=$1",[idea.id,JSON.stringify({...idea.proposal,status:'stale'}),JSON.stringify('The evidence changed; the proposal needs a fresh review.'),this.now()]);
  }
  async capture(input:{id:string;title:string;question:string;source?:{label:string;url:string};visibility?:'public'|'private';actor?:LabActor},settings:LabSettings){
    const id=identifier(input.id),content={title:text(input.title,140),question:text(input.question,3000),organization:ideaOrganization(undefined),source:input.source?{label:text(input.source.label,160),url:publicUrl(input.source.url)}:null,nextStep:'Consider the idea and its sources.',proposal:null};
    return this.db.transaction(async q=>{await this.lock(q);const old=await this.idea(id,q);if(old){if(old.question!==content.question)throw Error('lab_capture_conflict');return old;}
      const {rows:[{n}]}=await q.query("SELECT count(*)::int AS n FROM claus_lab_ideas WHERE status='noted'");if(n>=100)throw Error('lab_queue_full');
      await q.query("INSERT INTO claus_lab_ideas(id,revision,status,visibility,content,next_at,created_at,updated_at) VALUES($1,1,'noted',$2,$3,$4,$4,$4)",[id,input.visibility??'public',content,this.now()]);
      const idea=(await this.idea(id,q))!;await this.event(q,`${id}:captured`,idea,'idea_noted',input.actor??'claus','Idea saved',content.question,[],content.source?[content.source]:[]);return idea;
    });
  }
  async revise(id:string,revision:number,patch:{title?:string;question?:string;nextStep?:string;status?:IdeaStatus},actor:LabActor='claus'){
    return this.db.transaction(async q=>{await this.lock(q);const idea=await this.require(q,id,revision);
      const content={organization:{...ideaOrganization(idea.organization),openQuestions:[],evidenceIds:[]},title:patch.title?text(patch.title,140):idea.title,question:patch.question?text(patch.question,3000):idea.question,source:idea.source,nextStep:patch.nextStep?text(patch.nextStep,400):idea.nextStep,proposal:idea.proposal?{...idea.proposal,status:'stale'}:null};
      const status=patch.status??'queued';if(!['noted','queued','researching','waiting','reviewing','ready','parked','blocked'].includes(status))throw Error('lab_invalid_status');
      // Only prepareProposal can promote a dossier to ready.
      if(status==='ready')throw Error('lab_review_required');
      await q.query('UPDATE claus_lab_ideas SET revision=revision+1,status=$2,content=$3,next_at=$4,updated_at=$4 WHERE id=$1',[id,status,content,this.now()]);
      const next=(await this.idea(id,q))!;await this.event(q,`${id}:revision:${next.revision}`,next,'idea_updated',actor,'Idea updated',content.nextStep);return next;
    });
  }
  async organize(id:string,revision:number,value:unknown,actionId:string,actor:LabActor='claus'){
    return this.db.transaction(async q=>{await this.lock(q);const idea=await this.require(q,id,revision);
      const organization=mergeIdeaOrganization(idea.organization,value),inputHash=hash(value);
      if(idea.visibility!=='public')throw Error('lab_organization_source_invalid');
      const {rows:[old]}=await q.query('SELECT content FROM claus_lab_events WHERE event_key=$1',[actionId]);
      if(old){if(old.content.organizationInputHash?old.content.organizationInputHash!==inputHash:old.content.organizationHash!==hash(organization))throw Error('lab_organization_conflict');return ideaOrganization(idea.organization);}
      for(const related of organization.relatedIdeaIds){const target=await this.idea(related,q);if(related===id||target?.visibility!=='public')throw Error('lab_organization_source_invalid');}
      for(const eid of organization.evidenceIds){const {rows:[row]}=await q.query('SELECT content FROM claus_lab_evidence WHERE id=$1 AND idea_id=$2',[eid,id]);if(!row||row.content.visibility!=='public'||row.content.revision!==revision)throw Error('lab_organization_source_invalid');}
      // Questions may derive from the original public conversation. Findings
      // still require their own cited evidence; these labels grant no authority.
      if(!idea.source&&!organization.evidenceIds.length)throw Error('lab_organization_source_invalid');
      if(hash(organization)===hash(ideaOrganization(idea.organization)))return organization;
      await this.invalidateProposal(q,idea);
      await q.query("UPDATE claus_lab_ideas SET content=jsonb_set(content,'{organization}',$2::jsonb),updated_at=$3 WHERE id=$1",[id,JSON.stringify(organization),this.now()]);
      await this.event(q,actionId,idea,'idea_organized',actor,'Research focus updated',organization.openQuestions.join('\n')||'Research topics and related ideas updated.',organization.evidenceIds,idea.source?[idea.source]:[]);
      await q.query("UPDATE claus_lab_events SET content=content||$2::jsonb WHERE event_key=$1",[actionId,JSON.stringify({organizationHash:hash(organization),organizationInputHash:inputHash})]);
      return organization;
    });
  }
  async portfolio(query='',limit=20){
    if(typeof query!=='string'||query.length>120)throw Error('lab_invalid_work_query');
    const {rows}=await this.db.query("SELECT * FROM claus_lab_ideas WHERE visibility='public' AND ($1='' OR strpos(lower((content->>'title')||' '||(content->>'question')),lower($1))>0) ORDER BY updated_at DESC,id LIMIT $2",[query,Math.min(50,Math.max(1,limit))]);
    return rows.map(r=>{const i=projectIdea(this.ideaRow(r));return {id:i.id,title:i.title,status:i.status,question:textPrefix(i.question,400),organization:i.organization,updatedAt:i.updatedAt};});
  }
  async nameIdea(id:string,revision:number,title:string){return this.db.transaction(async q=>{await this.lock(q);const idea=await this.require(q,id,revision),name=text(title,140);if(name===idea.title)return;
    // Naming keeps the original question, source revision and reviewed proposal.
    await q.query("UPDATE claus_lab_ideas SET content=jsonb_set(content,'{title}',$2::jsonb),updated_at=$3 WHERE id=$1",[id,JSON.stringify(name),this.now()]);
  });}
  async progress(id:string,revision:number,status:IdeaStatus,nextStep:string,delaySeconds=0){
    return this.db.transaction(async q=>{await this.lock(q);await this.require(q,id,revision);if(status==='ready')throw Error('lab_review_required');
      await q.query("UPDATE claus_lab_ideas SET status=$2,content=jsonb_set(content,'{nextStep}',$3::jsonb),next_at=$4,updated_at=$5 WHERE id=$1",[id,status,JSON.stringify(text(nextStep,400)),new Date(this.now().getTime()+delaySeconds*1000),this.now()]);return this.idea(id,q);
    });
  }
  async park(id:string,revision:number,reason:string,actionId:string){
    const conclusion=text(reason,1600);
    return this.db.transaction(async q=>{await this.lock(q);const idea=await this.require(q,id,revision);
      const {rows:[old]}=await q.query('SELECT content FROM claus_lab_events WHERE event_key=$1',[actionId]);
      if(old){if(old.content.summary!==conclusion||old.content.kind!=='research_parked')throw Error('lab_event_conflict');return idea;}
      const preview=conclusion.length>400?textPrefix(conclusion,397).trimEnd()+'…':conclusion;
      await q.query("UPDATE claus_lab_ideas SET status='parked',content=jsonb_set(content,'{nextStep}',$2::jsonb),updated_at=$3 WHERE id=$1",[id,JSON.stringify(preview),this.now()]);
      await this.event(q,actionId,idea,'research_parked','claus','Research conclusion',conclusion);
      return this.idea(id,q);
    });
  }
  async claim(worker:string,settings:LabSettings,reconcileOnly=false):Promise<Idea|null>{return this.db.transaction(async q=>{await this.lock(q);
    const {rows:[{n}]}=await q.query('SELECT count(*)::int AS n FROM claus_lab_ideas WHERE lease_until>$1',[this.now()]);if(n>=settings.maxConcurrentJobs)return null;
    const {rows:[row]}=await q.query("SELECT * FROM claus_lab_ideas WHERE visibility='public' AND (status IN ('noted','queued','researching','waiting','reviewing') OR EXISTS(SELECT 1 FROM claus_lab_effects e WHERE e.idea_id=claus_lab_ideas.id AND (e.status IN ('reserved','started','uncertain') OR e.kind IN ('imd','experiment') AND e.status='completed' AND e.result->>'materialized'='false' OR e.kind='model' AND e.status='completed' AND e.revision=claus_lab_ideas.revision AND e.result->>'applied'='false'))) AND (status!='noted' OR (SELECT count(*) FROM claus_lab_ideas a WHERE a.status IN ('queued','researching','waiting','reviewing'))<$3) AND next_at<=$1 AND (lease_until IS NULL OR lease_until<$1) AND (NOT $2::boolean OR EXISTS(SELECT 1 FROM claus_lab_effects e WHERE e.idea_id=claus_lab_ideas.id AND (e.kind='model' AND e.status IN ('started','uncertain') OR e.kind='imd' AND (e.status IN ('started','uncertain') AND e.private_data->>'phase' IN ('submitted','submitting','polling') OR e.status='completed' AND e.result->>'materialized'='false')))) ORDER BY next_at,created_at LIMIT 1 FOR UPDATE",[this.now(),reconcileOnly,settings.maxActiveIdeas]);if(!row)return null;
    await q.query("UPDATE claus_lab_ideas SET lease_owner=$2,lease_until=$3,status=CASE WHEN status='noted' THEN 'queued' ELSE status END WHERE id=$1",[row.id,identifier(worker),new Date(this.now().getTime()+720000)]);return this.idea(row.id,q);
  });}
  async defer(id:string,revision:number,seconds:number){await this.assertLease();await this.db.query('UPDATE claus_lab_ideas SET next_at=GREATEST(next_at,$3) WHERE id=$1 AND revision=$2',[id,revision,new Date(this.now().getTime()+seconds*1000)]);}
  async release(id:string,worker:string){await this.db.query('UPDATE claus_lab_ideas SET lease_owner=NULL,lease_until=NULL,next_at=GREATEST(next_at,$3) WHERE id=$1 AND lease_owner=$2',[id,worker,this.now()]);}
  async evidence(id:string):Promise<Evidence[]>{return (await this.db.query('SELECT content FROM claus_lab_evidence WHERE idea_id=$1 ORDER BY id',[id])).rows.map(r=>r.content);}
  async publicEvidence(id:string):Promise<Evidence|null>{
    const {rows:[row]}=await this.db.query("SELECT e.content FROM claus_lab_evidence e JOIN claus_lab_ideas i ON i.id=e.idea_id WHERE e.id=$1 AND i.visibility='public' AND e.content->>'visibility'='public' AND e.revision=i.revision",[identifier(id)]);
    return row?.content??null;
  }
  async addEvidence(input:Evidence){return this.db.transaction(async q=>{await this.lock(q);const idea=await this.idea(input.ideaId,q);if(!idea)throw Error('lab_idea_missing');
    const evidence:Evidence={id:identifier(input.id),ideaId:idea.id,revision:input.revision,kind:input.kind,actor:input.actor,title:text(input.title,160),url:publicUrl(input.url),summary:text(input.summary,1600),body:text(input.body,1048576),contentHash:hash(input.body),observedAt:iso(input.observedAt),effectId:identifier(input.effectId),visibility:input.visibility};
    const effect=await this.effect(input.effectId,q);if(!effect||effect.ideaId!==idea.id||effect.revision!==input.revision||effect.status!=='completed')throw Error('lab_receipt_required');
    const {rows:[old]}=await q.query('SELECT content FROM claus_lab_evidence WHERE id=$1',[evidence.id]);if(old){if(hash(old.content)!==hash(evidence))throw Error('lab_evidence_conflict');return old.content as Evidence;}
    await q.query('INSERT INTO claus_lab_evidence(id,idea_id,revision,content) VALUES($1,$2,$3,$4)',[evidence.id,idea.id,evidence.revision,evidence]);
    if(evidence.visibility==='public'&&idea.revision===evidence.revision&&evidence.kind!=='review')await this.invalidateProposal(q,idea);
    if(evidence.visibility==='public'&&idea.revision===evidence.revision)await this.event(q,`${evidence.id}:saved`,idea,evidence.kind==='imd_result'?'research_received':evidence.kind==='experiment'?'experiment_completed':'source_read',evidence.actor,evidence.title,evidence.summary,[evidence.id],[{label:evidence.title,url:evidence.url}]);return evidence;
  });}
  async note(input:{id:string;ideaId:string;ideaRevision:number;expectedRevision:number;title?:string;body?:string;evidenceIds?:string[];deleted?:boolean;actionId?:string},actor:LabActor='claus'){
    return this.db.transaction(async q=>{await this.lock(q);const idea=await this.require(q,input.ideaId,input.ideaRevision),id=identifier(input.id);
      const {rows:[old]}=await q.query('SELECT * FROM claus_lab_notes WHERE id=$1',[id]);
      if(input.actionId){const {rows:[applied]}=await q.query('SELECT content FROM claus_lab_events WHERE event_key=$1',[input.actionId]);if(applied){if(applied.content.noteId!==id)throw Error('lab_note_conflict');return {id,revision:old.revision,deleted:old.deleted,...(old.deleted?{}:old.content)};}}
      if((old?.revision??0)!==input.expectedRevision||old&&old.idea_id!==idea.id)throw Error('lab_note_conflict');
      if(input.deleted&&!old)throw Error('lab_note_missing');
      if(old&&actor==='claus'&&old.content.author!=='claus')throw Error('lab_note_not_owned');
      const evidenceIds=(input.evidenceIds??old?.content.evidenceIds??[]).map((id:string)=>identifier(id));
      const citations:{label:string;url:string}[]=[];
      if(!input.deleted)for(const eid of evidenceIds){const {rows:[e]}=await q.query('SELECT content FROM claus_lab_evidence WHERE id=$1 AND idea_id=$2',[eid,idea.id]);if(!e||e.content.visibility!=='public'||e.content.revision!==idea.revision&&!(old?.content.evidenceIds??[]).includes(eid))throw Error('lab_note_source_invalid');citations.push({label:e.content.title,url:e.content.url});}
      const content=input.deleted?old.content:{title:text(input.title,160),body:text(input.body,6000),evidenceIds,author:old?.content.author??actor};
      const revision=input.expectedRevision+1,deleted=!!input.deleted;
      await this.invalidateProposal(q,idea);
      await q.query('INSERT INTO claus_lab_notes(id,idea_id,revision,content,deleted,updated_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET revision=$3,content=$4,deleted=$5,updated_at=$6',[id,idea.id,revision,content,deleted,this.now()]);
      await q.query('INSERT INTO claus_lab_note_history(note_id,revision,content,deleted,created_at) VALUES($1,$2,$3,$4,$5)',[id,revision,content,deleted,this.now()]);
      await this.event(q,input.actionId??`${id}:note:${revision}`,idea,deleted?'note_removed':old?'note_updated':'note_published',actor,deleted?'Note removed':content.title,deleted?'This note has been removed.':content.body,deleted?[]:content.evidenceIds,citations.slice(0,12),id,revision);
      return {id,revision,deleted,...(deleted?{}:content)};
    });
  }
  async notes(id:string){return (await this.db.query('SELECT id,revision,content FROM claus_lab_notes WHERE idea_id=$1 AND deleted=false ORDER BY updated_at DESC',[id])).rows.map(r=>({id:r.id,revision:r.revision,...r.content}));}
  async basis(id:string,q:LabQuery=this.db){
    const idea=await this.idea(id,q);if(!idea)throw Error('lab_idea_missing');
    const {rows:e}=await q.query("SELECT id,content FROM claus_lab_evidence WHERE idea_id=$1 AND revision=$2 AND content->>'visibility'='public' AND content->>'kind'!='review' ORDER BY id",[id,idea.revision]);
    const {rows:n}=await q.query('SELECT id,revision,content FROM claus_lab_notes WHERE idea_id=$1 AND deleted=false ORDER BY id',[id]);
    return hash({revision:idea.revision,...(idea.organization?{organization:idea.organization}:{}),evidence:e.map(r=>({id:r.id,contentHash:r.content.contentHash})),notes:n.map(r=>({id:r.id,revision:r.revision,content:r.content}))});
  }
  async prepareProposal(id:string,revision:number,input:Record<string,any>,reviewId:string){return this.db.transaction(async q=>{await this.lock(q);const idea=await this.require(q,id,revision),candidate=proposalCandidate(input);
    const {rows:[review]}=await q.query('SELECT content FROM claus_lab_evidence WHERE id=$1 AND idea_id=$2 AND revision=$3',[reviewId,id,revision]);
    if(review?.content.kind!=='review'||review.content.visibility!=='public')throw Error('lab_review_required');
    const report=JSON.parse(review.content.body);
    if(report.pass!==true||report.candidateHash!==hash(candidate)||report.basisHash!==await this.basis(id,q)||typeof report.factsHash!=='string')throw Error('lab_review_stale');
    if(idea.proposal?.review?.id===reviewId)return idea.proposal;
    const p:PublicProposal={id:`${id}:proposal`,revision:(idea.proposal?.revision??0)+1,sourceRevision:revision,createdAt:this.now().toISOString(),status:'pending',...candidate,review:{id:reviewId,candidateHash:report.candidateHash,basisHash:report.basisHash,factsHash:report.factsHash}};
    await q.query("UPDATE claus_lab_ideas SET status='ready',content=jsonb_set(jsonb_set(content,'{proposal}',$2::jsonb),'{nextStep}',$3::jsonb),updated_at=$4 WHERE id=$1",[id,JSON.stringify(p),JSON.stringify('Ready for an owner decision.'),this.now()]);
    await this.event(q,`${id}:proposal:${p.revision}`,idea,'proposal_ready','claus',p.title,p.summary,[reviewId]);return p;
  });}
  async reviseRejectedProposal(id:string,revision:number,reviewId:string){return this.db.transaction(async q=>{await this.lock(q);
    const idea=await this.require(q,id,revision);
    const {rows:[review]}=await q.query('SELECT content FROM claus_lab_evidence WHERE id=$1 AND idea_id=$2 AND revision=$3',[reviewId,id,revision]);
    if(review?.content.kind!=='review'||review.content.visibility!=='public')throw Error('lab_review_required');
    const report=JSON.parse(review.content.body);
    // A failed check is feedback for the author, not another review request.
    // Preserve the exact old proposal and never overwrite a newer/parked one.
    if(report.pass!==false||idea.proposal?.status!=='stale'||idea.status==='parked'
      ||report.candidateHash!==hash(proposalCandidate(idea.proposal))
      ||report.basisHash!==await this.basis(id,q))return false;
    const nextStep='Revise the proposal using the saved review feedback before requesting another review.';
    await q.query("UPDATE claus_lab_ideas SET status='queued',content=jsonb_set(jsonb_set(content,'{proposal}',$2::jsonb),'{nextStep}',$3::jsonb),next_at=$4,updated_at=$4 WHERE id=$1",[id,JSON.stringify({...idea.proposal,status:'revise'}),JSON.stringify(nextStep),this.now()]);
    await this.event(q,`${reviewId}:revision-requested`,idea,'proposal_revision_requested','system','Proposal needs revision',nextStep,[reviewId]);
    return true;
  });}
  async decide(id:string,revision:number,proposalRevision:number,decision:'approved'|'revise'|'parked',factsHash?:string){
    if(!['approved','revise','parked'].includes(decision))throw Error('lab_invalid_decision');
    return this.db.transaction(async q=>{await this.lock(q);const idea=await this.require(q,id,revision);if(idea.proposal?.status==='stale')throw Error('lab_review_stale');if(!idea.proposal||idea.proposal.revision!==proposalRevision||idea.proposal.sourceRevision!==revision||idea.proposal.status!=='pending')throw Error('lab_proposal_conflict');
      if(decision==='approved'&&(!idea.proposal.review||idea.proposal.review.basisHash!==await this.basis(id,q)||idea.proposal.review.candidateHash!==hash(proposalCandidate(idea.proposal))||idea.proposal.review.factsHash!==factsHash))throw Error('lab_review_stale');
      const p={...idea.proposal,status:decision};await q.query("UPDATE claus_lab_ideas SET status=$2,content=jsonb_set(content,'{proposal}',$3::jsonb),updated_at=$4 WHERE id=$1",[id,decision==='revise'?'queued':decision==='parked'?'parked':'ready',JSON.stringify(p),this.now()]);
      await this.event(q,`${id}:decision:${proposalRevision}`,idea,'owner_decision','team','Proposal reviewed',decision==='approved'?'Approved for the team to plan the build.':decision==='revise'?'More research requested.':'Set aside for now.');return p;
    });
  }
  private effectRow(r:any):Effect{return {id:r.id,ideaId:r.idea_id,revision:r.revision,kind:r.kind,status:r.status,input:r.input,result:r.result,privateData:r.private_data,amount:String(r.amount),currency:r.currency,period:r.period,createdAt:iso(r.created_at),updatedAt:iso(r.updated_at)};}
  async effect(id:string,q:LabQuery=this.db):Promise<Effect|null>{const {rows:[r]}=await q.query('SELECT * FROM claus_lab_effects WHERE id=$1',[id]);return r?this.effectRow(r):null;}
  async effects(id:string){return (await this.db.query('SELECT * FROM claus_lab_effects WHERE idea_id=$1 ORDER BY created_at,id',[id])).rows.map(r=>this.effectRow(r));}
  async reserve(input:{id:string;ideaId:string;revision:number;kind:Effect['kind'];input:any;amount:string;currency:Effect['currency']},settings:LabSettings){return this.db.transaction(async q=>{await this.lock(q);
    const existing=await this.effect(input.id,q);if(existing){if(hash(existing.input)!==hash(input.input)||existing.ideaId!==input.ideaId||existing.revision!==input.revision||existing.currency!==input.currency||existing.amount!==input.amount)throw Error('lab_effect_conflict');return existing;}
    const idea=await this.require(q,input.ideaId,input.revision);
    if(input.kind==='imd'){const {rows:[{n}]}=await q.query("SELECT count(*)::int AS n FROM claus_lab_effects WHERE kind='imd' AND status IN ('reserved','started','uncertain')");if(n>=settings.maxConcurrentJobs)throw Error('lab_job_limit');}
    const usage=await this.stepUsage(idea.id,settings,q);
    if(input.input?.reviewRefresh===true){
      const binding=input.input.reviewBinding;
      if(input.kind!=='model'||input.input.review!==true||idea.proposal?.status!=='stale'
        ||hash(proposalCandidate(idea.proposal))!==binding?.candidateHash
        ||hash(input.input.reviewCandidate)!==binding.candidateHash
        ||await this.basis(idea.id,q)!==binding.basisHash
        ||typeof binding.factsHash!=='string')throw Error('lab_review_stale');
      const {rows:[r]}=await q.query(`SELECT count(*)::int AS n FROM claus_lab_effects WHERE idea_id=$1
        AND input->>'reviewRefresh'='true' AND input->'reviewBinding'->>'factsHash'=$2
        AND input->'reviewBinding'->>'candidateHash'=$3 AND input->'reviewBinding'->>'basisHash'=$4`,[idea.id,binding.factsHash,binding.candidateHash,binding.basisHash]);
      if(r.n>=3)throw Error('lab_review_retry_limit');
    }else if(!usage.remaining)throw Error('lab_step_budget_exhausted');
    // Keep the final three slots for a finding, recommendation and reviewer.
    // Existing effects above still reconcile/reuse without a new reservation.
    if(input.kind!=='model'&&usage.remaining<=3)throw Error('lab_conclusion_required');
    if(!/^\d{1,24}$/.test(input.amount))throw Error('lab_invalid_budget');
    const amount=BigInt(input.amount),period=this.now().toISOString().slice(0,10);
    if(input.kind==='experiment'){
      if(!settings.experiments)throw Error('lab_experiment_disabled');
      const {rows:[counts]}=await q.query("SELECT count(*) FILTER(WHERE period=$1)::int AS daily,count(*) FILTER(WHERE idea_id=$2)::int AS idea,count(*) FILTER(WHERE status IN ('reserved','started','uncertain'))::int AS pending FROM claus_lab_effects WHERE kind='experiment'",[period,input.ideaId]);
      if(counts.pending>0)throw Error('lab_experiment_pending');
      if(counts.daily>=4||counts.idea>=2)throw Error('lab_experiment_limit');
    }
    const daily=input.currency==='USDC'?settings.modelDailyBudgetMicroUsdc:settings.imdDailyBudgetAtomic,perIdea=input.currency==='USDC'?settings.modelIdeaBudgetMicroUsdc:settings.imdIdeaBudgetAtomic;
    if(input.currency!=='NONE'){
      if(input.currency==='IMD'&&!settings.paidResearch)throw Error('lab_paid_research_disabled');
      // Outstanding commitments from older days remain charged until reconciled.
      const {rows:[totals]}=await q.query("SELECT COALESCE(sum(committed) FILTER (WHERE period=$2 OR status IN ('reserved','started','uncertain')),0)::text AS daily,COALESCE(sum(committed) FILTER (WHERE idea_id=$3),0)::text AS idea FROM (SELECT *,CASE WHEN status='completed' THEN COALESCE(accounted_amount,amount) ELSE amount END AS committed FROM claus_lab_effects WHERE currency=$1 AND status!='failed') e",[input.currency,period,input.ideaId]);
      if(BigInt(totals.idea)+amount>BigInt(perIdea))throw Object.assign(Error('lab_budget_exhausted'),{scope:'idea'});
      if(BigInt(totals.daily)+amount>BigInt(daily))throw Object.assign(Error('lab_budget_exhausted'),{scope:'daily'});
    }else if(amount!==0n)throw Error('lab_invalid_budget');
    await q.query("INSERT INTO claus_lab_effects(id,idea_id,revision,kind,status,input_hash,input,amount,currency,period,created_at,updated_at) VALUES($1,$2,$3,$4,'reserved',$5,$6,$7,$8,$9,$10,$10)",[identifier(input.id),idea.id,idea.revision,input.kind,hash(input.input),input.input,input.amount,input.currency,period,this.now()]);
    await q.query('UPDATE claus_lab_ideas SET steps=steps+1 WHERE id=$1',[idea.id]);return (await this.effect(input.id,q))!;
  });}
  async effectState(id:string,expected:Effect['status'][],status:Effect['status'],result:any=null,privateData:any=undefined,billing?:ModelCommitment){return this.db.transaction(async q=>{await this.lock(q);const effect=await this.effect(id,q);if(!effect)throw Error('lab_effect_missing');if(!expected.includes(effect.status))throw Error('lab_effect_state_conflict');
    if(billing&&status!=='completed')throw Error('lab_invalid_model_commitment');
    const amount=billing?commitmentAmount(effect,billing):null;
    await q.query('UPDATE claus_lab_effects SET status=$2,result=$3,private_data=$4,updated_at=$5,accounted_amount=COALESCE($6,accounted_amount) WHERE id=$1',[id,status,result,privateData===undefined?effect.privateData:privateData,this.now(),amount]);return (await this.effect(id,q))!;
  });}
  async recordReceipt(id:string,kind:string,title:string,summary:string,sources:{label:string;url:string}[]=[]){return this.db.transaction(async q=>{await this.lock(q);const effect=await this.effect(id,q);if(!effect||effect.status==='reserved'||effect.status==='uncertain')throw Error('lab_receipt_required');const idea=await this.idea(effect.ideaId,q);if(!idea||idea.revision!==effect.revision)return;await this.event(q,`${id}:${kind}`,idea,kind,effect.kind==='imd'?'imd':'claus',title,summary,[],sources);});}
  async beginRunner(recover=false){return this.db.transaction(async q=>{await this.lock(q);
    const {rows:[old]}=await q.query('SELECT * FROM claus_lab_runner WHERE id=1 FOR UPDATE');
    if(old?.state==='running'&&(!recover||new Date(old.deadline).getTime()>this.now().getTime()))return null;
    const generation=(old?.generation??0)+1,deadline=new Date(this.now().getTime()+840000);
    await q.query("INSERT INTO claus_lab_runner(id,generation,state,turn_after,deadline) VALUES(1,$1,'running',$2,$3) ON CONFLICT(id) DO UPDATE SET generation=$1,state='running',turn_after=$2,deadline=$3",[generation,this.now(),deadline]);return generation;
  });}
  async claimRunnerTurn(generation:number){return this.db.transaction(async q=>{await this.lock(q);
    const {rows}=await q.query("UPDATE claus_lab_runner SET turn_after=$3,deadline=$3 WHERE id=1 AND generation=$1 AND state='running' AND turn_after<=$2 RETURNING id",[generation,this.now(),new Date(this.now().getTime()+840000)]);return rows.length===1;
  });}
  async finishRunnerTurn(generation:number,delaySeconds:number,paused=false){await this.db.query("UPDATE claus_lab_runner SET state=$2,turn_after=$3,deadline=$4 WHERE id=1 AND generation=$1",[generation,paused?'paused':'running',new Date(this.now().getTime()+delaySeconds*1000),new Date(this.now().getTime()+(delaySeconds+840)*1000)]);}
  async heartbeat(state:'working'|'waiting'|'idle'|'paused',settings:LabSettings){await this.db.query('INSERT INTO claus_lab_runtime(id,content,updated_at) VALUES(1,$1,$2) ON CONFLICT(id) DO UPDATE SET content=$1,updated_at=$2',[{state,enabled:settings.enabled},this.now()]);}
  async envelope(mode:'preview'|'live'='live'){
    const now=this.now(),{rows:[r]}=await this.db.query(`SELECT r.*,EXISTS(
      SELECT 1 FROM claus_lab_ideas i JOIN claus_lab_effects e ON e.idea_id=i.id AND e.revision=i.revision
      WHERE i.visibility='public' AND i.lease_until>$1 AND e.kind IN ('model','imd') AND e.status IN ('started','uncertain')
    ) AS pending FROM claus_lab_runtime r WHERE r.id=1`,[now]);
    const old=r&&now.getTime()-new Date(r.updated_at).getTime()>180000;
    // A bounded, leased provider request can exceed the heartbeat interval.
    // Keep its real timestamp and distinguish waiting from a lost worker.
    const state=!r?'paused':r.content.state==='paused'?'paused':old?(r.content.state==='working'&&r.pending?'waiting':'stale'):r.content.state;
    return {version:1 as const,mode,asOf:now.toISOString(),status:{state,updatedAt:r?iso(r.updated_at):null}};
  }
  private currentIdea(idea:Idea,factsHash?:string):Idea {
    const p=idea.proposal;
    if(factsHash&&p&&['pending','approved'].includes(p.status)&&p.review?.factsHash!==factsHash)return {...idea,status:'reviewing',nextStep:'Current hook facts changed; this proposal needs another review.',proposal:{...p,status:'stale'}};
    return idea;
  }
  async ideas(limit=20,factsHash?:string){return (await this.db.query("SELECT * FROM claus_lab_ideas WHERE visibility='public' ORDER BY updated_at DESC,id LIMIT $1",[Math.min(100,Math.max(1,limit))])).rows.map(r=>projectIdea(this.currentIdea(this.ideaRow(r),factsHash)));}
  async feed(options:{after?:string;before?:string;idea?:string;limit?:number}={}){
    if(options.after&&options.before||options.before&&!/^\d{1,20}$/.test(options.before)||options.after&&!/^\d{1,20}$/.test(options.after))throw Error('lab_invalid_cursor');const limit=Math.min(50,Math.max(1,options.limit??20));
    const {rows}=await this.db.query(`SELECT e.*,i.content->>'title' AS idea_title FROM claus_lab_events e JOIN claus_lab_ideas i ON i.id=e.idea_id LEFT JOIN claus_lab_notes n ON n.id=e.content->>'noteId' WHERE i.visibility='public' AND ($1::bigint IS NULL OR e.seq>$1) AND ($2::text IS NULL OR e.idea_id=$2) AND ($4::bigint IS NULL OR e.seq<$4) AND (n.id IS NULL OR (e.content->>'noteRevision')::integer=n.revision) AND NOT EXISTS(SELECT 1 FROM claus_lab_evidence v WHERE v.id IN (SELECT jsonb_array_elements_text(e.content->'evidenceIds')) AND v.content->>'visibility'!='public') ORDER BY e.seq ${options.after?'ASC':'DESC'} LIMIT $3`,[options.after??null,options.idea??null,limit+1,options.before??null]);
    const events:PublicEvent[]=rows.slice(0,limit).map(r=>({id:r.content.noteId?`note:${r.content.noteId}`:r.event_key,cursor:String(r.seq),ideaId:r.idea_id,ideaTitle:r.idea_title,kind:r.content.kind,actor:r.content.actor,title:r.content.title,summary:r.content.summary,occurredAt:r.content.occurredAt,publishedAt:iso(r.created_at),sources:r.content.sources??[],evidenceIds:r.content.evidenceIds??[]}));
    return {events,nextCursor:events.length?String(options.after?events.at(-1)!.cursor:events[0].cursor):options.after??null,hasMore:rows.length>limit};
  }
  async detail(id:string,factsHash?:string){const saved=await this.idea(id),idea=saved?this.currentIdea(saved,factsHash):null;if(!idea||idea.visibility!=='public')return null;const evidence=(await this.evidence(id)).filter(e=>e.visibility==='public'&&e.revision===idea.revision).map(({id,title,url,summary,contentHash,observedAt,actor,kind})=>({id,title,url,summary,contentHash,observedAt,actor,kind}));return {idea:projectIdea(idea),evidence,events:(await this.feed({idea:id,limit:50})).events,proposal:idea.proposal,notes:await this.notes(id),jobs:(await this.effects(id)).filter(e=>e.kind==='imd').map(e=>({id:e.id,revision:e.revision,status:e.result?.status??e.status,jobId:e.result?.jobId??e.privateData?.jobId??null,observedAt:e.result?.observedAt??e.updatedAt,deliveryComplete:e.status==='completed'&&e.result?.deliveryComplete===true&&e.result?.materialized===true}))};}
}
