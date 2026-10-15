import {publicPresentation} from './presentation.js';
export function normalizeGraph(pages) {
  const nodes = new Map(), edges = new Map(), resources = new Map();
  for (const page of pages) {
    if (page?.schemaVersion !== '1.0' || !Array.isArray(page.nodes) || !Array.isArray(page.edges)) throw Error('invalid_graph');
    for (const node of page.nodes) {
      if (node.id === 'claus') continue;
      if (node.kind !== 'project' || typeof node.id !== 'string' || node.id.length > 120 ||
        !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(node.slug) ||
        typeof node.label !== 'string' || node.label.length > 80) throw Error('invalid_node');
      nodes.set(node.id, { id: node.id, slug: node.slug, label: node.label, registryLabel:node.label,
        description:typeof node.description==='string'?node.description.slice(0,500):'',
        kind: 'project', status: 'registered', href: '/c/' + node.slug, presentation:publicPresentation(node.presentation) });
    }
    for (const edge of page.edges) {
      if (edge.relation === 'registered_with' && edge.target === 'claus') edges.set(edge.source, edge);
      else if(['used_service','accepted_work'].includes(edge.relation)&&typeof edge.source==='string'&&typeof edge.target==='string'&&edge.source!==edge.target) {
        const evidenceIds=(edge.evidenceIds??[]).filter(id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,120}$/.test(id));
        const expected='/v1/public/apps/'+encodeURIComponent(edge.source)+'/tasks/';
        if(edge.relation==='accepted_work'&&(!evidenceIds.length||edge.evidenceHref!==expected+encodeURIComponent(evidenceIds[0])+'/receipt'))continue;
        edges.set([edge.source,edge.target,edge.relation].join('|'),{source:edge.source,target:edge.target,relation:edge.relation,
          ...(edge.relation==='accepted_work'?{evidenceIds,evidenceHref:edge.evidenceHref}:{})});
      }
    }
    for (const item of page.resources ?? []) {
      if (!['service', 'agent', 'interface', 'contract', 'result', 'signal'].includes(item.kind) ||
        typeof item.id !== 'string' || item.id.length > 200 || typeof item.projectId !== 'string' ||
        typeof item.label !== 'string' || item.label.length > 80) throw Error('invalid_resource');
      resources.set(item.id, { id: item.id, projectId: item.projectId, kind: item.kind, label: item.label });
    }
  }
  const projects = [...nodes.values()].sort((a, b) => a.slug.localeCompare(b.slug, 'en'));
  for (const project of projects) {
    if(project.presentation?.name)project.label=project.presentation.name;
    const items = [...resources.values()].filter(item => item.projectId === project.id);
    if (items.length) project.resources = items;
    project.providers=[...edges.values()].filter(e=>e.relation==='used_service'&&e.source===project.id&&nodes.has(e.target))
      .map(e=>({id:e.target,label:nodes.get(e.target).label,href:nodes.get(e.target).href}));
    project.collaborators=[...edges.values()].filter(e=>e.relation==='accepted_work'&&e.source===project.id&&nodes.has(e.target))
      .map(e=>({id:e.target,label:nodes.get(e.target).label,href:nodes.get(e.target).href,
        evidenceIds:e.evidenceIds,evidenceHref:'https://claus-network-api.vercel.app'+e.evidenceHref}));
  }
  return { projects, edges: [...edges.values()].filter(e=>nodes.has(e.source)&&(e.target==='claus'||nodes.has(e.target))) };
}
// Detailed observations enrich the fast registry without replacing its fresher
// project identities, visibility or artwork. Cross-page targets remain intact.
export function mergeGraphConnections(projects,pages) {
  const registry={schemaVersion:'1.0',nodes:projects.map(p=>({...p,kind:'project'})),edges:[]};
  const graph=normalizeGraph([...pages.map(p=>({...p,nodes:[]})),registry]);
  const details=new Map(graph.projects.map(p=>[p.id,p]));
  return projects.map(p=>({...p,providers:details.get(p.id)?.providers??[],collaborators:details.get(p.id)?.collaborators??[]}));
}
export function visibleProjects(projects, capacity = 8) {
  if (projects.length <= capacity) return { individual: projects, grouped: [] };
  return { individual: projects.slice(0, capacity - 1), grouped: projects.slice(capacity - 1) };
}

export function projectSlots(width, height, obstacles, capacity = 8) {
  const radius = 24, gap = 8, margin = radius + 4;
  const candidates = [[margin, margin], [width - margin, margin],
    [margin, height - margin], [width - margin, height - margin]];
  for (const y of [.22, .78, .38, .62, .5]) candidates.push([margin, height * y], [width - margin, height * y]);
  for (const x of [.2, .8, .35, .65, .5]) candidates.push([width * x, margin], [width * x, height - margin]);
  const slots = [];
  for (const [x, y] of candidates) {
    if (x < radius || y < radius || x + radius > width || y + radius > height) continue;
    if (obstacles.some(b => x - radius - gap < b.right && x + radius + gap > b.left &&
      y - radius - gap < b.bottom && y + radius + gap > b.top)) continue;
    if (slots.some(p => Math.abs(p.x - x) < 56 && Math.abs(p.y - y) < 56)) continue;
    slots.push({ x, y }); if (slots.length === capacity) break;
  }
  return slots;
}
