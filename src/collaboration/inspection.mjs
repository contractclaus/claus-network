import {requireThat} from '../shared/index.mjs';
// Inspect registry and immutable hosted source, without executing or fetching external URLs.
export function createProjectInspection({projects,releases,dependencies,actions=async()=>({actions:[]}),now=Date.now}){
 return async function inspect(slug){
  const project=await projects.publicProject(slug);requireThat(project,'not_found');
  const [sites,relations,declared]=await Promise.all([releases.publicForProject(project.projectId),dependencies.get(project.projectId),actions(project.projectId)]);
  const checks=[{id:'published-project',state:'passed',evidence:'/read/network/'+slug,detail:'Project is publicly listed.'},{id:'published-site',state:sites.length?'passed':'action',detail:sites.length?'A published website is available.':'Publish a website release so visitors can use this project.'},{id:'public-agents',state:project.agents?.length?'passed':'optional',detail:project.agents?.length?'Agent identities are published.':'Publish an agent identity if this project has one.'},{id:'description',state:project.description?.trim()?'passed':'action',detail:project.description?.trim()?'A public description is present.':'Add a description explaining the service.'},{id:'agent-actions',state:declared.actions.length?'passed':'optional',detail:declared.actions.length+' declared actions. Use project_actions_set to explain how agents interact.'}];
  const active=[...sites].sort((a,b)=>b.createdAt-a.createdAt||b.id.localeCompare(a.id))[0];
  if(active){const site=await releases.public(active.id),paths=new Set(site.files.map(f=>f.path)),missing=new Set();for(const f of site.files.filter(f=>f.path.endsWith('.html'))){for(const match of f.content.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)){const raw=match[1];if(/^(?:[a-z]+:|\/|#)/i.test(raw))continue;const resolved=new URL(raw,'https://preview.invalid/'+f.path);const path=resolved.pathname.slice(1);if(/\.(?:html|css|js|svg|json)$/.test(path)&&!paths.has(path))missing.add(path);}}
   checks.push({id:'local-links',state:missing.size?'action':'passed',detail:missing.size?'Missing local files: '+[...missing].slice(0,8).join(', '):'Referenced local HTML, CSS, JS, SVG and JSON files exist.'});
   const home=site.files.find(f=>f.path==='index.html')?.content??'';
   const visible=home.replace(/<!--[\s\S]*?-->/g,'').replace(/<(head|script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'').replace(/<[^>]*>/g,' ').replace(/&(?:nbsp|#160|#x0*a0);/gi,' ').trim();
   checks.push({id:'readable-html',state:visible?'passed':'action',detail:'Basic check for text in the source HTML; does not execute scripts or evaluate CSS visibility.'});
  }
  return {projectId:project.projectId,slug,observedAt:now(),checks,sites,dependencies:relations.items,scope:'Current public configuration and local references. Not code execution, external uptime, an audit or proof of usage.'};
 };
}
