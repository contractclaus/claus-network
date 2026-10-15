import { SITE_LIMITS, canonical, copy, digest, integer, requireThat, text, sourcePath, sourceText } from '../shared/index.mjs';

const projectRef = (projectId, id) => digest({ projectId, id });
const filePath = sourcePath, prose = sourceText;

export function createProjects({ store, identity, publicDetails = async () => ({}), publicAppearance = async () => ({}), publicConnections = async () => ({state:'not_configured',edges:[],nextCursor:null}), now = () => Date.now(), limit = async () => undefined, consumeSnapshotBytes = async () => {}, visible = async () => true, visibleMany }) {
  async function snapshot(reader, projectId, id) {
    const value = (await reader.read('snapshots', projectRef(projectId, id)))?.value;
    requireThat(value && value.projectId === projectId, 'not_found');
    return value;
  }
  const api = {
    async resources(actor, projectId, { kind, after = '', limit = 100 }) {
      // Fixed, scoped metadata projections. Bodies and secrets use their own authorized endpoints.
      const kinds = {
        snapshots: ['snapshots', 'artifact.read'], builds: ['builds', 'artifact.read'],
        jobs: ['workflow-jobs', 'project.read'], reviews: ['review-cases', 'review.read'],
        proposals: ['chain-proposals', 'proposal.read'], services: ['service-versions', 'service.read'],
        orders: ['service-orders', 'service.read'], releases: ['project-releases', 'resource.read'],
        bindings: ['contract-bindings', 'contract.read'], requests: ['contract-requests', 'contract.read'],
        signals: ['signal-operations', 'signal.read'], results: ['service-result-publications','service.read']
      };
      requireThat(Object.hasOwn(kinds, kind), 'invalid_resource_kind'); integer(limit, 1, 100);
      const [collection, scope] = kinds[kind];
      await identity.authorize(actor, scope, { projectId });
      const rows = await store.list(collection, { after, limit, projectId });
      const fields = ['id', 'projectId', 'state', 'kind', 'createdAt', 'updatedAt', 'snapshotId', 'buildId',
        'jobId', 'quoteJobId', 'executionJobId', 'artifactHash', 'serviceId', 'quoteId', 'expiresAt'];
      const items = rows.filter(row => row.value.projectId === projectId).map(row =>
        Object.fromEntries(fields.filter(key => Object.hasOwn(row.value, key)).map(key => [key, row.value[key]])));
      return { items, nextCursor: rows.length === limit ? rows.at(-1).id : null };
    },
    async publishAgent(actor, projectId, { agentId, published, expectedRevision }) {
      requireThat(typeof published === 'boolean', 'invalid_publication'); integer(expectedRevision);
      return store.transaction(async tx => {
        await identity.authorize(actor, 'project.publish', { projectId, withdrawal: !published }, tx);
        const agent = (await tx.read('principals', text(agentId)))?.value;
        requireThat(agent?.kind === 'agent' && agent.projectId === projectId, 'not_found');
        const value = { projectId, agentId, name: agent.name, published };
        const row = await tx.write('project-public-agents', projectId + ':' + agentId, value, expectedRevision);
        await tx.event({ type: published ? 'agent.published' : 'agent.withdrawn', projectId, agentId, at: now() });
        return { ...value, revision: row.revision };
      }, {projectId});
    },
    async get(actor, projectId) {
      const project = await identity.project(actor, projectId);
      const publication = await store.read('public-projects', project.slug);
      return { ...project, publication: { published: publication?.value.published === true,
        revision: publication?.revision ?? 0, description: publication?.value.description ?? '' } };
    },
    async createSnapshot(actor, projectId, { files, expectedProjectRevision }) {
      integer(expectedProjectRevision, 1);
      requireThat(Array.isArray(files) && files.length > 0 && files.length <= SITE_LIMITS.files, 'invalid_files');
      const clean = files.map(file => {
        requireThat(file && Object.keys(file).length === 2 && typeof file.content === 'string', 'invalid_file');
        const path = filePath(file.path), content = prose(file.content, SITE_LIMITS.fileBytes);
        requireThat(Buffer.byteLength(content) <= SITE_LIMITS.fileBytes, 'file_too_large');
        return { path, content, hash: digest({ path, content }) };
      }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
      requireThat(new Set(clean.map(x => x.path)).size === clean.length, 'duplicate_file');
      requireThat(Buffer.byteLength(canonical(clean)) <= SITE_LIMITS.totalBytes, 'snapshot_too_large');
      const id = digest(clean.map(({ path, hash }) => ({ path, hash })));
      return store.transaction(async tx => {
        await identity.authorize(actor, 'snapshot.create', { projectId }, tx);
        const project = await tx.read('projects', projectId);
        requireThat(project.revision === expectedProjectRevision, 'revision_conflict');
        const old = (await tx.read('snapshots', projectRef(projectId, id)))?.value;
        if (old) return old;
        const usage = await tx.read('snapshot-capacity', projectId);
        const bytes = Buffer.byteLength(canonical(clean));
        requireThat((usage?.value.count ?? 0) < (await limit('snapshotsPerProject', tx) ?? 64) &&
          (usage?.value.bytes ?? 0) + bytes <= (await limit('snapshotBytesPerProject', tx) ?? 8000000), 'capacity_reached');
        await consumeSnapshotBytes(tx, bytes);
        for (const file of clean) {
          const key = projectRef(projectId, file.hash);
          if (!await tx.read('artifacts', key)) await tx.write('artifacts', key, { projectId, ...file }, 0);
        }
        const value = { id, projectId, files: clean.map(({ path, hash }) => ({ path, hash })), createdAt: now() };
        await tx.write('snapshots', projectRef(projectId, id), value, 0);
        await tx.write('snapshot-capacity', projectId, { count: (usage?.value.count ?? 0) + 1,
          bytes: (usage?.value.bytes ?? 0) + bytes }, usage?.revision ?? 0);
        await tx.event({ type: 'snapshot.created', projectId, snapshotId: id, at: now() });
        return value;
      });
    },
    async snapshot(actor, projectId, id) {
      await identity.authorize(actor, 'artifact.read', { projectId });
      return snapshot(store, projectId, id);
    },
    async describeSnapshot(actor, projectId, id) {
      const version = await api.snapshot(actor, projectId, id);
      const publication = await store.read('public-sources', projectRef(projectId, id));
      return { ...version, publication: { published: publication?.value.published === true,
        revision: publication?.revision ?? 0 } };
    },
    async files(actor, projectId, snapshotId) {
      await identity.authorize(actor, 'artifact.read', { projectId });
      const version = await snapshot(store, projectId, snapshotId);
      const result = [];
      for (let i=0;i<version.files.length;i+=8) result.push(...await Promise.all(version.files.slice(i,i+8).map(async entry=>(await store.read('artifacts',projectRef(projectId,entry.hash))).value)));
      return result;
    },
    async publishSource(actor, projectId, { snapshotId, expectedRevision, published }) {
      requireThat(typeof published === 'boolean', 'invalid_publication'); integer(expectedRevision);
      return store.transaction(async tx => {
        await identity.authorize(actor, 'source.publish', { projectId, withdrawal: !published }, tx);
        const version = await snapshot(tx, projectId, snapshotId), key = projectRef(projectId, snapshotId);
        const old = await tx.read('public-sources', key);
        requireThat((old?.revision ?? 0) === expectedRevision, 'revision_conflict');
        const result = await tx.write('public-sources', key, { projectId, snapshotId, published, files: version.files }, expectedRevision);
        await tx.event({ type: published ? 'source.published' : 'source.withdrawn', projectId, snapshotId, at: now() });
        return { id: key, revision: result.revision, published };
      }, {projectId});
    },
    async publicSource(id) {
      const publication = (await store.read('public-sources', text(id)))?.value;
      requireThat(publication?.published === true && await visible(publication.projectId), 'not_found');
      const files = [];
      for (const entry of publication.files) {
        const artifact = (await store.read('artifacts', projectRef(publication.projectId, entry.hash))).value;
        files.push({ path: artifact.path, content: artifact.content, hash: artifact.hash });
      }
      return { projectId: publication.projectId, snapshotId: publication.snapshotId, files };
    },
    async publish(actor, projectId, { published, expectedRevision, description = '' }) {
      requireThat(typeof published === 'boolean', 'invalid_publication'); integer(expectedRevision); prose(description, 500);
      return store.transaction(async tx => {
        await identity.authorize(actor, 'project.publish', { projectId, withdrawal: !published }, tx);
        const project = (await tx.read('projects', projectId)).value;
        const old = await tx.read('public-projects', project.slug);
        requireThat((old?.revision ?? 0) === expectedRevision, 'revision_conflict');
        const value = { projectId, slug: project.slug, name: project.name, description, published, updatedAt: now() };
        const result = await tx.write('public-projects', project.slug, value, expectedRevision);
        await tx.event({ type: published ? 'project.published' : 'project.withdrawn', projectId, at: now() });
        return { ...result.value, revision: result.revision };
      }, {projectId});
    },
    async publicProject(slug, {view = 'full'} = {}) {
      requireThat(['full','appearance'].includes(view),'invalid_project_view');
      const record = await store.read('public-projects', text(slug));
      requireThat(record?.value.published === true && await visible(record.value.projectId), 'not_found');
      const project = (await store.read('projects', record.value.projectId))?.value;
      requireThat(project && !project.archivedAt, 'not_found');
      // A logo lookup should not wait for unrelated services, apps or chain evidence.
      if(view==='appearance')return {...record.value,revision:record.revision,...await publicAppearance(record.value.projectId)};
      // Independent public reads begin only after the publication/visibility gates.
      const [agentRows,evidenceRow,details]=await Promise.all([
        store.list('project-public-agents',{prefix:record.value.projectId+':',limit:128}),
        store.read('public-evidence',record.value.projectId),publicDetails(record.value.projectId)
      ]);
      const agents=agentRows.filter(row=>row.value.published).map(row=>({id:row.value.agentId,name:row.value.name,revision:row.revision}));
      // Evidence is written only by the trusted workflow, not profile input.
      const evidence=evidenceRow?.value??{reviews:[],decisions:[],deployments:[]};
      return {...record.value,revision:record.revision,agents,evidence,...details};
    },
    async publicAgents({after='',limit=25}={}) {
      integer(limit,1,25);const rows=await store.list('project-public-agents',{after,limit});
      const ids=[...new Set(rows.filter(r=>r.value.published).map(r=>r.value.projectId))];
      const many=(collection,keys)=>store.readMany?store.readMany(collection,keys):Promise.all(keys.map(async id=>[id,await store.read(collection,id)])).then(r=>new Map(r));
      const [owned,allowed]=await Promise.all([many('projects',ids),visibleMany?visibleMany(ids):Promise.all(ids.map(async id=>[id,await visible(id)])).then(r=>new Set(r.filter(([,ok])=>ok).map(([id])=>id)))]);
      const candidates=rows.filter(r=>r.value.published&&allowed.has(r.value.projectId)&&owned.get(r.value.projectId)?.value&&!owned.get(r.value.projectId).value.archivedAt);
      const pages=await many('public-projects',[...new Set(candidates.map(r=>owned.get(r.value.projectId).value.slug))]);
      const items=candidates.flatMap(row=>{const p=owned.get(row.value.projectId).value,pub=pages.get(p.slug)?.value;return pub?.published&&pub.projectId===p.id?[{id:row.value.agentId,projectId:row.value.projectId,name:row.value.name,revision:row.revision,url:'/c/'+p.slug+'#agents'}]:[];});
      return {items,nextCursor:rows.length===limit?rows.at(-1).id:null};
    },
    async graph({ after = '', limit = 100, view = 'full' } = {}) {
      requireThat(['full','projects'].includes(view), 'invalid_graph_view');
      // Full observations resolve several public resources per project. Bound each
      // page instead of timing out an oversized request; callers retain the cursor.
      const pageLimit=view==='full'?Math.min(limit,20):limit;
      const records = await store.list('public-projects', { after, limit:pageLimit });
      if (view === 'projects') {
        const published=records.filter(row=>row.value.published), ids=published.map(row=>row.value.projectId);
        const [owned, allowed]=await Promise.all([
          store.readMany ? store.readMany('projects',ids) : Promise.all(ids.map(async id=>[id,await store.read('projects',id)])).then(rows=>new Map(rows)),
          visibleMany ? visibleMany(ids) : Promise.all(ids.map(async id=>[id,await visible(id)])).then(rows=>new Set(rows.filter(([,ok])=>ok).map(([id])=>id)))
        ]);
        const nodes=published.filter(row=>allowed.has(row.value.projectId)&&owned.get(row.value.projectId)?.value&&!owned.get(row.value.projectId).value.archivedAt).map(row=>({
          id:row.value.projectId,slug:row.value.slug,label:row.value.name,description:row.value.description,
          kind:'project',href:'/c/'+row.value.slug,revision:row.revision,status:'registered',updatedAt:row.value.updatedAt
        }));
        return {schemaVersion:'1.0',view:'projects',observedAt:now(),nodes:[{id:'claus',label:'Claus',kind:'coordinator',href:'/Network'},...nodes],resources:[],
          edges:nodes.map(p=>({source:p.id,target:'claus',relation:'registered_with'})),nextCursor:records.length===limit?records.at(-1).id:null};
      }
      const projects = [], resources = [], relations = [], connectionCoverage=[];
      const published=records.filter(x=>x.value.published), resolved=[];
      for(let i=0;i<published.length;i+=4) resolved.push(...await Promise.all(published.slice(i,i+4).map(async record=>{
        try{const project=await api.publicProject(record.value.slug);return {record,project,connections:await publicConnections(project)};}
        catch(error){if(error.code==='not_found')return null;throw error;}
      })));
      for (const item of resolved) {
        if(!item)continue;const {record,project,connections}=item;
        relations.push(...connections.edges);
        connectionCoverage.push({projectId:project.projectId,state:connections.state,nextCursor:connections.nextCursor});
        const href = '/c/' + project.slug;
        projects.push({ id: project.projectId, slug: project.slug, label: project.name, kind: 'project',
          href, revision: record.revision, status: 'registered' });
        for (const [field, kind, relation, section] of [['services', 'service', 'offers', 'services'],
          ['agents', 'agent', 'belongs_to', 'agents'], ['releases', 'interface', 'published_interface', 'interfaces']]) {
          for (const item of project[field] ?? []) {
            const id = kind + ':' + item.id;
            resources.push({ id, projectId: project.projectId, kind, label: item.name ?? 'Interface', href: href + '#' + section });
            relations.push({ source: id, target: project.projectId, relation });
          }
        }
        for (const item of project.evidence.deployments ?? []) {
          const id = 'contract:' + project.projectId + ':' + item.chainId + ':' + item.address;
          resources.push({ id, projectId: project.projectId, kind: 'contract', label: item.address,
            chainId: item.chainId, status: item.verification, href: href + '#contracts' });
          relations.push({ source: id, target: project.projectId, relation: 'deployed_contract' });
        }
        for (const result of project.results ?? []) {
          const id = 'result:' + result.id;
          resources.push({ id, projectId: project.projectId, kind: 'result', label: 'Published result',
            href: href + '#results', outputHash: result.outputHash, expiresAt: result.expiresAt,
            sourceResults: result.sourceResults });
          relations.push({ source: id, target: project.projectId, relation: 'published_result' });
          relations.push({ source: project.projectId, target: result.providerProjectId, relation: 'used_service', evidence: result.id });
          for (const source of result.sourceResults ?? []) relations.push({source:id,target:'result:'+source.id,relation:'derived_from'});
        }
        for (const signal of project.signals ?? []) {
          const id='signal:'+project.projectId;
          resources.push({id,projectId:project.projectId,kind:'signal',label:'Signal feed',chainId:signal.chainId,
            address:signal.address,profile:signal.profile,href:href+'#signals',apiHref:signal.href});
          relations.push({source:id,target:project.projectId,relation:'publishes_signal'});
        }
      }
      const relationMap=new Map(),resourceIds=new Set(resources.map(r=>r.id));
      for(const edge of relations){
        if(edge.relation==='derived_from'&&!resourceIds.has(edge.target))continue;
        const key=[edge.source,edge.target,edge.relation].join('|'),prior=relationMap.get(key);
        if(prior){if(edge.evidence)prior.evidenceIds.push(edge.evidence);}
        else relationMap.set(key,{source:edge.source,target:edge.target,relation:edge.relation,
          ...(edge.evidence?{evidenceIds:[edge.evidence]}:{}),...(edge.meaning?{meaning:edge.meaning}:{}),...(edge.evidenceHref?{evidenceHref:edge.evidenceHref}:{})});
      }
      return {
        schemaVersion: '1.0', observedAt: now(),
        nodes: [{ id: 'claus', label: 'Claus', kind: 'coordinator', href: '/Network' }, ...projects],
        // Additive resources keep 1.0 project-only clients compatible.
        resources,
        connectionCoverage,
        edges: [...projects.map(p => ({ source: p.id, target: 'claus', relation: 'registered_with' })), ...relationMap.values()],
        nextCursor: records.length === pageLimit ? records.at(-1).id : null
      };
    },
    async export(actor, projectId, { snapshotId }) {
      await identity.authorize(actor, 'project.export', { projectId });
      const project = await identity.project(actor, projectId);
      const version = await snapshot(store, projectId, snapshotId);
      const files = await api.files(actor, projectId, snapshotId);
      return { schemaVersion: '1.0', exportedAt: now(), project, snapshot: version,
        files: files.map(({ path, content, hash }) => ({ path, content, hash })) };
    }
  };
  return api;
}
