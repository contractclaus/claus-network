import { copy, digest, integer, requireThat, shape, text } from '../shared/index.mjs';
import { createPolicies } from '../policies/index.mjs';

// Technical admission only. This module cannot create funding or chain grants.
export const ACCESS_DEFAULTS = Object.freeze({
  publicCollaboration: false, publicDataServices: false, paused: false,
  projectsPerOwner: 10, agentsPerProject: 32, mandatesPerDay: 64, credentialsPerDay: 128,
  snapshotsPerProject: 64, snapshotBytesPerProject: 8000000,
  buildsPerProjectDay: 16, buildsPerDay: 256,
  serviceVersionsPerProject: 64, quotesPerProjectDay: 64, ordersPerProjectDay: 16,
  releasesPerProject: 32, newProjectsPerDay: 64, newProjectsTotal: 2000,
  newSnapshotBytesPerDay: 64000000, newSnapshotBytesTotal: 512000000,
  authRequestsPerPeer: 30, authRequestsGlobal: 200, requestsPerPeer: 300, requestsGlobal: 3000
});
export const ACCESS_MAXIMA = Object.freeze(Object.fromEntries(Object.entries(ACCESS_DEFAULTS)
  .filter(([, value]) => typeof value === 'number').map(([key, value]) => [key, value * 4])));

export function createAccess({ store, identity, reviewAdmission = async () => null, reviewEligibility, chainAdmission, mainnetAdmission, signalDiscovery = async () => [], intakeDiscovery = async () => [], now = () => Date.now() }) {
  async function owner(actor, reader = store) {
    const who = await identity.credential(actor, reader);
    const principal = (await reader.read('principals', who.principalId))?.value;
    const authority = (await reader.read('network', 'authority'))?.value;
    requireThat(who.kind === 'owner' && principal?.chainId === 1 &&
      principal.address === authority?.ownerAddress, 'scope_denied');
    return true;
  }
  const policies = createPolicies({ store, now,
    authorize: (actor, _action, _scope, reader) => owner(actor, reader),
    schemas: { 'project-access': config => {
      shape(config, Object.keys(ACCESS_DEFAULTS).filter(key => key !== 'publicDataServices' || Object.hasOwn(config, key)));
      requireThat(typeof config.publicCollaboration === 'boolean' && typeof config.paused === 'boolean', 'invalid_access_policy');
      requireThat(config.publicDataServices === undefined || typeof config.publicDataServices === 'boolean', 'invalid_access_policy');
      for (const [key, maximum] of Object.entries(ACCESS_MAXIMA)) integer(config[key], 1, maximum);
    } }
  });
  async function policy(reader = store) {
    if (!await reader.read('policy-active', 'project-access'))
      return { version: 'legacy', generation: 0, config: copy(ACCESS_DEFAULTS) };
    return policies.active('project-access', reader);
  }
  async function limit(key, reader = store) { return (await policy(reader)).config[key]; }
  async function consume(reader, kind, amount, dailyKey, totalKey) {
    const config = (await policy(reader)).config;
    requireThat(!config.paused, 'project_admission_paused');
    for (const [period, maximum] of [[Math.floor(now() / 86400000), config[dailyKey]], ['total', config[totalKey]]]) {
      const id = digest({ kind, period }), old = await reader.read('access-capacity', id);
      const used = old?.value.used ?? 0;
      requireThat(used + amount <= maximum, 'capacity_reached');
      await reader.write('access-capacity', id, { kind, period, used: used + amount }, old?.revision ?? 0);
    }
  }
  async function collaboration(projectId, reader = store) {
    const config = (await policy(reader)).config;
    requireThat(!config.paused, 'project_admission_paused');
    const project = (await reader.read('projects', projectId))?.value;
    const status = (await reader.read('project-access', projectId))?.value;
    requireThat(project && !project.archivedAt && !project.transfer && !status?.suspended, 'project_unavailable');
    requireThat((await reader.read('network-capabilities', 'collaboration'))?.value.enabled === true, 'collaboration_not_enabled');
    if (!config.publicCollaboration) {
      const pilot = (await reader.read('review-pilots', projectId))?.value;
      requireThat(pilot?.enabled === true && pilot.expiresAt > now(), 'sponsor_not_enabled');
    }
  }
  async function discovery() {
    const active = await policy(), cap = async name => (await store.read('network-capabilities', name))?.value;
    const fresh = async name => (await store.read('worker-health', name))?.value.observedAt > now() - 300000;
    const reviews = await reviewAdmission(store);
    const collaborationEnabled = (await cap('collaboration'))?.enabled === true;
    const chainEnabled = (await cap('chain'))?.enabled === true;
    let chainState = chainEnabled ? 'restricted_pilot' : 'not_enabled';
    if (chainEnabled && chainAdmission) {
      try { await chainAdmission(store); chainState = 'public_readonly'; }
      catch (error) { if (!['chain_public_not_enabled','chain_admission_changed','chain_scope_not_reviewed'].includes(error.code)) throw error; }
    }
    let mainnetState = 'not_enabled';
    if ((await cap('chain:1'))?.enabled && mainnetAdmission) {
      try { await mainnetAdmission(store); mainnetState = 'public_readonly'; }
      catch (error) { if (!['chain_public_not_enabled','chain_admission_changed','chain_scope_not_reviewed'].includes(error.code)) throw error; }
    }
    const reviewEnabled = (await cap('review'))?.enabled === true;
    return { schemaVersion: '1.0', observedAt: now(), policyVersion: active.version, policyGeneration: active.generation,
      authentication: { kind: 'ethereum-eoa', chainId: 1, contractWallets: false },
      projectAccess: active.config.paused ? 'paused' : 'public',
      collaboration: { admission: active.config.paused ? 'paused' : !collaborationEnabled ? 'not_enabled' :
        active.config.publicCollaboration ? 'public' : 'restricted_pilot', worker: await fresh('services') ? 'ready' : 'unavailable' },
      staticHosting: { isolated: true, backendExecution: false },
      publicDataServices: { enabled: collaborationEnabled && !active.config.paused && active.config.publicDataServices === true,
        policy: 'public-data-v1', maximumLineageDepth: 3, explicitResultPublication: true },
      transfers: { enabled: (await cap('portability'))?.enabled === true, trustedDestinationRequired: true },
      reviews: { admission: !reviewEnabled ? 'not_enabled' : reviews?.config.enabled && (reviews.config.expiresAt === null || reviews.config.expiresAt > now()) ? 'public_sponsored' : 'restricted_pilot', reservationRequired: true, projectPrice: '0', asset: 'IMD', chainId: 1 },
      chainProfiles: [{ chainId: 11155111, profile: 'claus-readonly-v1', admission: chainState },
        { chainId: 1, profile: 'claus-readonly-v1', admission: mainnetState }],
      signalProfiles: await signalDiscovery(), contractIntake: await intakeDiscovery(),
      mainnet: mainnetState, publicInference: 'not_enabled', limits: copy(active.config) };
  }
  return { policy, limit, collaboration, discovery,
    async publicData(projectId, reader = store) {
      await collaboration(projectId, reader);
      requireThat((await policy(reader)).config.publicDataServices === true, 'public_data_not_enabled');
    },
    consumeProjects: reader => consume(reader, 'projects', 1, 'newProjectsPerDay', 'newProjectsTotal'),
    consumeSnapshotBytes: (reader, bytes) => consume(reader, 'snapshotBytes', bytes, 'newSnapshotBytesPerDay', 'newSnapshotBytesTotal'),
    async project(actor, projectId) {
      await identity.authorize(actor, 'project.read', { projectId });
      const active = await policy(), cache = new Map();
      const reader = { read: (collection, id) => {
        const key = JSON.stringify([collection, id]);
        if (!cache.has(key)) cache.set(key, store.read(collection, id));
        return cache.get(key);
      } };
      const granted = await Promise.all(identity.scopes.map(action => identity.allowed(actor, action, { projectId }, reader)));
      const scopes = identity.scopes.filter((_, i) => granted[i]);
      const status = await store.read('project-access', projectId);
      let sponsorActive = false;
      try { sponsorActive = !!await reviewEligibility?.(store, projectId); } catch (error) { if (error.code !== 'sponsor_not_enabled') throw error; }
      let free = { available: true, reason: null, next: null };
      try { await collaboration(projectId); }
      catch (error) { free = { available: false, reason: error.code, next: 'Read capabilities for current admission; retain existing resource IDs.' }; }
      const day = Math.floor(now() / 86400000);
      const quota = async (collection, id, key, field = 'count') => {
        const used = (await store.read(collection, id))?.value[field] ?? 0, maximum = active.config[key];
        return { used, maximum, remaining: Math.max(0, maximum - used) };
      };
      return { projectId, policyVersion: active.version, policyGeneration: active.generation, scopes,
        suspended: status?.value.suspended === true, accessRevision: status?.revision ?? 0, collaboration: free,
        reviews: { eligible: sponsorActive, reason: sponsorActive ? null : 'sponsor_not_enabled',
          reservationRequired: true, projectPrice: '0' },
        quotas: {
          agents: await quota('identity-capacity', digest({ kind: 'agents', subject: projectId }), 'agentsPerProject'),
          snapshots: await quota('snapshot-capacity', projectId, 'snapshotsPerProject'),
          snapshotBytes: await quota('snapshot-capacity', projectId, 'snapshotBytesPerProject', 'bytes'),
          buildsToday: await quota('build-admission', digest({ scope: projectId, day, version: 'compile-admission-v1' }), 'buildsPerProjectDay'),
          serviceVersions: await quota('service-capacity', digest({ kind: 'versions', subject: projectId }), 'serviceVersionsPerProject'),
          quotesToday: await quota('service-capacity', digest({ kind: 'quotes', subject: projectId + ':' + day }), 'quotesPerProjectDay'),
          ordersToday: await quota('service-capacity', digest({ kind: 'orders', subject: projectId + ':' + day }), 'ordersPerProjectDay'),
          releases: await quota('release-capacity', projectId, 'releasesPerProject')
        } };
    },
    async getPolicy(actor) { await owner(actor); return policy(); },
    publishPolicy: (actor, input) => policies.publish({ actor, module: 'project-access', version: input.version, config: input.config }),
    activatePolicy: (actor, input) => policies.activate({ actor, module: 'project-access', version: input.version, expectedGeneration: input.expectedGeneration }),
    async setProject(actor, projectId, { suspended, expectedRevision }) {
      requireThat(typeof suspended === 'boolean', 'invalid_project_access'); integer(expectedRevision);
      return store.transaction(async tx => {
        await owner(actor, tx); requireThat(await tx.read('projects', text(projectId)), 'not_found');
        const row = await tx.write('project-access', projectId, { suspended }, expectedRevision);
        await tx.event({ type: 'project.access_changed', projectId, suspended, revision: row.revision, at: now() });
        return { projectId, suspended, revision: row.revision };
      });
    }
  };
}
