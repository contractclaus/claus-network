import {ROUTES,validate} from './contract.mjs';

export function createService({identity,projects,builds,jobs,reviews,deployments,approvals,services,wallets,releases}){
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
  module_deploy:(actor,input)=>deployments.deployModule(actor,input.projectId,input),
  module_get:(actor,input)=>deployments.module(actor,input.projectId,input.moduleId),
  registration_prepare:(actor,input)=>deployments.prepareRegistration(actor,input.projectId,input),
  registration_submit:(actor,input)=>deployments.submitRegistration(actor,input.projectId,input),
  registration_get:(actor,input)=>deployments.registration(actor,input.projectId,input.registrationId),
  chain_binding:(actor,input)=>deployments.binding(actor,input.projectId),
  proposal_create:(actor,input)=>approvals.create(actor,input.projectId,input),
  proposal_get:(actor,input)=>approvals.get(actor,input.projectId,input.proposalId),
  proposal_publish:(actor,input)=>approvals.publish(actor,input.projectId,input),
  service_register:(actor,input)=>services.register(actor,input.projectId,input.manifest),
  service_get:(actor,input)=>services.version(actor,input.projectId,input.serviceId),
  service_publish:(actor,input)=>services.publish(actor,input.projectId,input),
  service_suspend:(actor,input)=>services.suspend(actor,input.projectId,input.serviceId),
  service_catalog:(_,input)=>services.discovery(input),
  service_quote:(actor,input)=>services.quote(actor,input.projectId,input),
  service_accept:(actor,input)=>services.accept(actor,input.projectId,input.quoteId),
  service_order:(actor,input)=>services.get(actor,input.projectId,input.orderId),
  service_authorize:(actor,input)=>services.authorizeOrder(actor,input.projectId,input),
  service_cancel:(actor,input)=>services.cancel(actor,input.projectId,input.orderId),
  service_result:(actor,input)=>services.result(actor,input.projectId,input.orderId),
  service_accept_result:(actor,input)=>services.acceptResult(actor,input.projectId,input),
  provider_orders:(actor,input)=>services.assigned(actor,input.projectId,input),
  provider_claim:(actor,input)=>services.claim(actor,input.projectId,input.orderId),
  provider_deliver:(actor,input)=>services.deliver(actor,input.projectId,input),
  wallet_create:(actor,input)=>wallets.create(actor,input.projectId),
  wallet_get:(actor,input)=>wallets.wallet(actor,input.projectId),
  wallet_action:(actor,input)=>wallets.action(actor,input.projectId,input.actionId),
  wallet_session_prepare:(actor,input)=>wallets.prepareSession(actor,input.projectId,input.session),
  wallet_session_submit:(actor,input)=>wallets.submitSession(actor,input.projectId,input),
  wallet_session_revoke:(actor,input)=>wallets.revokeRequest(actor,input.projectId,input.sessionId),
  wallet_payment_prepare:(actor,input)=>wallets.preparePayment(actor,input.projectId,input),
  wallet_payment_submit:(actor,input)=>wallets.submitPayment(actor,input.projectId,input),
  release_create:(actor,input)=>releases.create(actor,input.projectId,input),
  release_get:(actor,input)=>releases.get(actor,input.projectId,input.releaseId),
  release_publish:(actor,input)=>releases.publish(actor,input.projectId,input),
  public_release:(_,input)=>releases.public(input.releaseId),
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
