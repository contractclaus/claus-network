import {ROUTES,validate} from './contract.mjs';

export function createService({identity,projects,builds,jobs,reviews}){
 const operations={
  auth_challenge:(_,input)=>identity.challenge(input),
  auth_session:(_,input)=>identity.session(input),
  principal_me:actor=>identity.me(actor),
  project_list:(actor,input)=>identity.projects(actor,input),
  project_create:(actor,input)=>identity.createProject(actor,input),
  project_get:(actor,input)=>identity.project(actor,input.projectId),
  agent_create:(actor,input)=>identity.createAgent(actor,input.projectId,input),
  mandate_create:(actor,input)=>identity.grant(actor,input.projectId,input),
  mandate_revoke:(actor,input)=>identity.revoke(actor,'mandate',input.mandateId),
  credential_create:(actor,input)=>identity.issueCredential(actor,input),
  credential_rotate:(actor,input)=>identity.rotate(actor,input.credentialId),
  credential_revoke:(actor,input)=>identity.revoke(actor,'credential',input.credentialId),
  snapshot_create:(actor,input)=>projects.createSnapshot(actor,input.projectId,input),
  snapshot_get:(actor,input)=>projects.snapshot(actor,input.projectId,input.snapshotId),
  build_create:(actor,input)=>builds.submit(actor,input.projectId,input),
  build_get:(actor,input)=>builds.get(actor,input.projectId,input.buildId),
  build_artifact:(actor,input)=>builds.artifact(actor,input.projectId,input.buildId),
  job_get:(actor,input)=>jobs.get(actor,input.projectId,input.jobId),
  job_cancel:(actor,input)=>jobs.cancel(actor,input.projectId,input.jobId),
  review_create:(actor,input)=>reviews.request(actor,input.projectId,input),
  review_pilot_get:(actor,input)=>reviews.pilot(actor,input.projectId),
  review_pilot_set:(actor,input)=>reviews.setPilot(actor,input.projectId,input),
  review_get:(actor,input)=>reviews.get(actor,input.projectId,input.caseId),
  review_accept:(actor,input)=>reviews.accept(actor,input.projectId,input),
  review_artifact:(actor,input)=>reviews.artifact(actor,input.projectId,input.caseId),
  review_publish:(actor,input)=>reviews.publish(actor,input.projectId,input),
  source_publish:(actor,input)=>projects.publishSource(actor,input.projectId,input),
  project_publish:(actor,input)=>projects.publish(actor,input.projectId,input),
  project_export:(actor,input)=>projects.export(actor,input.projectId,input),
  public_project:(_,input)=>projects.publicProject(input.slug),
  public_source:(_,input)=>projects.publicSource(input.sourceId),
  network_graph:(_,input)=>projects.graph(input)
 };
 return {
  routes:ROUTES,
  async execute(name,input,rawToken){
   const route=ROUTES.find(r=>r.name===name);
   if(!route||!operations[name])throw Object.assign(Error('not_found'),{code:'not_found'});
   validate(route.inputSchema,input);
   const actor=route.public?null:await identity.authenticate(rawToken);
   return operations[name](actor,input);
  }
 };
}
