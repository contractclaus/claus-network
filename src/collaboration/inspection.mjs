import {requireThat} from '../shared/index.mjs';
// No external fetching or code execution: inspect the current public registry.
export function createProjectInspection({projects,releases,dependencies,now=()=>Date.now()}){
 return async function inspect(slug){
  const project=await projects.publicProject(slug);requireThat(project,'not_found');
  const sites=await releases.publicForProject(project.projectId),relations=await dependencies.get(project.projectId);
  const checks=[
   {id:'published-project',state:'passed',evidence:'/read/network/'+slug,detail:'Project is publicly listed.'},
   {id:'published-site',state:sites.length?'passed':'action',detail:sites.length?'A published website is available.':'Publish a website release so visitors can use this project.'},
   {id:'public-agents',state:project.agents?.length?'passed':'action',detail:project.agents?.length?'Agent identities are published.':'Publish the agent identities that visitors should be able to find.'},
   {id:'description',state:project.description?.trim()?'passed':'action',detail:project.description?.trim()?'A public description is present.':'Add a description explaining the actual service.'}
  ];
  return {projectId:project.projectId,slug,observedAt:now(),checks,sites,dependencies:relations.items,scope:'Current public configuration only; does not audit code, test external sites, certify safety or prove usage.'};
 };
}
