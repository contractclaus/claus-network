import { randomBytes, randomUUID } from 'node:crypto';
import { copy, digest, integer, requireThat, text } from '../shared/index.mjs';

export const PROJECT_SCOPES = Object.freeze([
  'web.read','deal.evidence','deal.review','deal.prepare','deal.exit','worker.manage','worker.run','worker.read','worker.cancel','workflow.manage', 'workflow.cancel', 'app.use', 'app.manage', 'project.read', 'project.update', 'artifact.read', 'artifact.write',
  'snapshot.create', 'build.compile', 'review.quote', 'review.admit', 'review.read',
  'proposal.create', 'proposal.read', 'proposal.execute', 'project.publish',
  'project.export', 'source.publish', 'budget.read', 'events.read', 'job.cancel',
  'service.manage', 'service.read', 'service.call', 'service.provide',
  'wallet.read', 'wallet.manage', 'wallet.pay', 'release.publish', 'resource.read',
  'vault.read', 'vault.manage', 'wallet.revoke', 'service.settle', 'inference.read', 'inference.submit',
  'contract.read', 'contract.request', 'contract.revoke',
  'signal.read', 'signal.manage', 'signal.publish', 'signal.grant.revoke'
]);
export const APP_SESSION_ACTIONS=Object.freeze(['app_service_get','app_service_call','app_task_messages','app_task_message','app_task_review_request','app_task_review_submit','app_task_review_challenge','app_get','app_records','app_record_create','app_record_update','app_task_post','app_task_claim','app_task_deliver','app_task_accept','app_task_cancel','app_events']);
const FENCED_ACTIONS = new Set(['deal.exit','worker.read','worker.cancel','workflow.cancel','project.read', 'artifact.read', 'review.read', 'proposal.read', 'project.export',
  'budget.read', 'events.read', 'service.read', 'service.provide', 'service.settle', 'wallet.read', 'wallet.revoke',
  'resource.read', 'vault.read', 'job.cancel', 'inference.read', 'contract.read', 'contract.revoke', 'signal.read', 'signal.grant.revoke']);
const WITHDRAWAL_ACTIONS = new Set(['project.publish', 'source.publish', 'release.publish']);
const OWNER_TTL = 60 * 60 * 1000;
const MAX_MANDATE_TTL = 30 * 24 * OWNER_TTL;
const bounded = (value, max) => { text(value); requireThat(value.length <= max, 'value_too_long'); return value; };
const opaque = prefix => prefix + randomUUID();
const token = () => 'cln_' + randomBytes(32).toString('base64url');
const publicCredential = value => {
  const { id, principalId, projectId, mandateId, scopes, createdAt, expiresAt, revokedAt, kind } = value;
  return { id, principalId, projectId, mandateId, scopes, createdAt, expiresAt, revokedAt, kind,...(kind==='app'?{appId:value.appId,actions:value.actions}:{} )};
};

export function createIdentity({ store, verifySignature = async () => false,
  domain = 'claus.si', chainId = 1, now = () => Date.now(), limit = async () => undefined,
  consumeProjects = async () => {}, writesEnabled = async () => true }) {
  requireThat(/^[a-z0-9.-]+(?::[0-9]+)?$/.test(domain), 'invalid_domain');
  integer(chainId, 1);
  async function capacity(tx, kind, subject, maximum) {
    const names = { projects: 'projectsPerOwner', agents: 'agentsPerProject', 'mandates-per-day': 'mandatesPerDay', 'credentials-per-day': 'credentialsPerDay' };
    maximum = await limit(names[kind], tx) ?? maximum;
    const key = digest({ kind, subject }), old = await tx.read('identity-capacity', key);
    const count = old?.value.count ?? 0;
    requireThat(count < maximum, 'capacity_reached');
    await tx.write('identity-capacity', key, { kind, count: count + 1 }, old?.revision ?? 0);
  }
  async function credential(actor, reader = store) {
    text(actor);
    const value = (await reader.read('credentials', actor))?.value;
    requireThat(value && !value.revokedAt && value.expiresAt > now(), 'unauthenticated');
    if(value.kind==='app'){
      const parent=(await reader.read('credentials',value.parentId))?.value;
      requireThat(parent&&parent.kind!=='app'&&!parent.revokedAt&&parent.expiresAt>now()&&parent.principalId===value.principalId,'unauthenticated');
      if(parent.kind!=='owner')requireThat(await allowed(value.parentId,'app.use',{projectId:parent.projectId},reader),'scope_denied');
    }
    return value;
  }
  async function owner(actor, projectId, reader = store) {
    const who = await credential(actor, reader);
    requireThat(who.kind === 'owner', 'scope_denied');
    const project = (await reader.read('projects', text(projectId)))?.value;
    requireThat(project && project.ownerId === who.principalId, 'not_found');
    return { who, project };
  }
  async function allowed(actor, action, { projectId, withdrawal = false } = {}, reader = store) {
    try {
      const who = await credential(actor, reader);
      if(who.kind==='app')return false;
      const project = (await reader.read('projects', text(projectId)))?.value;
      if (!project || project.archivedAt) return false;
      const suspended = (await reader.read('project-access', projectId))?.value.suspended === true || !await writesEnabled(reader);
      if ((project.transfer || suspended) && !FENCED_ACTIONS.has(action) && !(withdrawal && WITHDRAWAL_ACTIONS.has(action))) return false;
      if (who.kind === 'owner') return project.ownerId === who.principalId && PROJECT_SCOPES.includes(action);
      const alias = action === 'wallet.revoke' ? 'wallet.manage' : action === 'service.settle' ? 'service.call' :
        action === 'contract.revoke' ? 'contract.request' : action;
      const scope = who.scopes.includes(action) ? action : alias;
      if (who.projectId !== projectId || !who.scopes.includes(scope)) return false;
      const mandate = (await reader.read('mandates', who.mandateId))?.value;
      return !!mandate && !mandate.revokedAt && mandate.expiresAt > now() &&
        mandate.projectId === projectId && mandate.principalId === who.principalId &&
        mandate.ownerId === project.ownerId && mandate.scopes.includes(scope);
    } catch (error) {
      if (['unauthenticated', 'not_found', 'invalid_identifier'].includes(error.code)) return false;
      throw error;
    }
  }
  async function authorize(actor, action, scope, reader = store) {
    requireThat(await allowed(actor, action, scope, reader), 'scope_denied');
  }
  const api = {
    allowed, authorize, credential, owner, scopes: PROJECT_SCOPES,
    async listAccess(actor, projectId, { kind, after = '', limit = 100 }) {
      await owner(actor, projectId); integer(limit, 1, 100);
      requireThat(['agents', 'mandates', 'credentials'].includes(kind), 'invalid_resource_kind');
      const rows = await store.list({ agents: 'principals', mandates: 'mandates', credentials: 'credentials' }[kind], { after, limit, projectId });
      const items = [];
      for (const row of rows.filter(row => row.value.projectId === projectId)) {
        const value = kind === 'credentials' ? publicCredential(row.value) : copy(row.value);
        if (kind === 'agents') {
          const publication = await store.read('project-public-agents', projectId + ':' + row.value.id);
          value.publication = { published: publication?.value.published === true, revision: publication?.revision ?? 0 };
        }
        items.push(value);
      }
      return { items, nextCursor: rows.length === limit ? rows.at(-1).id : null };
    },
    // Internal port used only after verification of an operator-signed transfer.
    // No public identity route accepts an arbitrary project ID.
    async importProject(actor, value, provenance, tx) {
      const who = await credential(actor, tx);
      requireThat(who.kind === 'owner', 'scope_denied');
      requireThat(/^prj_[a-z0-9-]{1,80}$/.test(value.id) &&
        /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(value.slug), 'invalid_project');
      bounded(value.name, 80);
      requireThat(!await tx.read('projects', value.id), 'project_id_taken');
      requireThat(!await tx.read('project-slugs', value.slug), 'slug_taken');
      await consumeProjects(tx);
      await capacity(tx, 'projects', who.principalId, 10);
      const project = { id: value.id, slug: value.slug, name: value.name, ownerId: who.principalId,
        createdAt: value.createdAt, archivedAt: null, provenance: copy(provenance) };
      await tx.write('projects', project.id, project, 0);
      await tx.write('project-slugs', project.slug, { projectId: project.id }, 0);
      await tx.write('memberships', who.principalId + ':' + project.id, { projectId: project.id, principalId: who.principalId }, 0);
      await tx.event({ type: 'project.imported', projectId: project.id, archiveId: provenance.archiveId, at: now() });
      return project;
    },
    async challenge({ address }) {
      requireThat(/^0x[0-9a-fA-F]{40}$/.test(address), 'invalid_address');
      address = address.toLowerCase();
      const id = opaque('auth_'), issuedAt = now(), expiresAt = issuedAt + 5 * 60 * 1000;
      const nonce = randomBytes(16).toString('hex');
      const message = `${domain} wants you to sign in with your Ethereum account:\n${address}\n\nSign in to Claus Network. This does not authorize a blockchain transaction.\n\nURI: https://${domain}/network\nVersion: 1\nChain ID: ${chainId}\nNonce: ${nonce}\nIssued At: ${new Date(issuedAt).toISOString()}\nExpiration Time: ${new Date(expiresAt).toISOString()}\nRequest ID: ${id}`;
      await store.transaction(tx => tx.write('auth-challenges', id, { id, address, message, chainId, expiresAt, consumedAt: null }, 0));
      return { id, message, chainId, expiresAt };
    },
    async session({ challengeId, signature }) {
      requireThat(/^0x[0-9a-fA-F]{130}$/.test(signature), 'invalid_signature');
      const challenge = (await store.read('auth-challenges', text(challengeId)))?.value;
      requireThat(challenge && !challenge.consumedAt && challenge.expiresAt > now(), 'challenge_expired');
      requireThat(await verifySignature({ address: challenge.address, message: challenge.message, signature, chainId }) === true, 'invalid_signature');
      const rawToken = token(), id = digest(rawToken);
      return store.transaction(async tx => {
        const current = await tx.read('auth-challenges', challengeId);
        requireThat(current && !current.value.consumedAt && current.value.expiresAt > now(), 'challenge_expired');
        requireThat(current.value.message === challenge.message, 'challenge_mismatch');
        const principalId = 'usr_' + digest({ address: challenge.address, chainId }).slice(7);
        if (!await tx.read('principals', principalId)) await tx.write('principals', principalId,
          { id: principalId, address: challenge.address, chainId, kind: 'human', createdAt: now() }, 0);
        const value = { id, kind: 'owner', principalId, projectId: null, mandateId: null,
          scopes: [], createdAt: now(), expiresAt: now() + OWNER_TTL, revokedAt: null };
        await tx.write('credentials', id, value, 0);
        await tx.write('auth-challenges', challengeId, { ...current.value, consumedAt: now() }, current.revision);
        return { token: rawToken, credential: publicCredential(value) };
      });
    },
    async authenticate(rawToken) {
      requireThat(typeof rawToken === 'string' && /^cln_[A-Za-z0-9_-]{43}$/.test(rawToken), 'unauthenticated');
      const actor = digest(rawToken);
      await credential(actor);
      return actor;
    },
    async appSession(actor,{appId,actions,expiresAt}){
      requireThat(Array.isArray(actions)&&actions.length>0&&actions.length<=APP_SESSION_ACTIONS.length&&actions.every(a=>APP_SESSION_ACTIONS.includes(a))&&new Set(actions).size===actions.length,'invalid_scopes');
      integer(expiresAt,now()+1000,now()+1800000);const rawToken=token(),id=digest(rawToken);
      return store.transaction(async tx=>{const parent=await credential(actor,tx);requireThat(parent.kind!=='app'&&expiresAt<=parent.expiresAt,'scope_denied');
        await capacity(tx,'credentials-per-day',parent.principalId+':app:'+Math.floor(now()/86400000),128);
        const value={id,kind:'app',principalId:parent.principalId,projectId:null,mandateId:null,scopes:[],appId,parentId:actor,actions:copy(actions),createdAt:now(),expiresAt,revokedAt:null};
        await tx.write('credentials',id,value,0);return {token:rawToken,credential:publicCredential(value)};
      });
    },
    async revokeAppSession(actor,appId,sessionId){return store.transaction(async tx=>{const who=await credential(actor,tx),old=await tx.read('credentials',sessionId);requireThat(who.kind!=='app'&&old?.value.kind==='app'&&old.value.appId===appId&&old.value.principalId===who.principalId,'scope_denied');if(!old.value.revokedAt)await tx.write('credentials',sessionId,{...old.value,revokedAt:now()},old.revision);return {id:sessionId,revoked:true};});},
    async me(actor) {
      const who = await credential(actor);
      return { credential: publicCredential(who), principal: (await store.read('principals', who.principalId))?.value };
    },
    async createProject(actor, { slug, name, idempotencyKey }) {
      requireThat(typeof slug === 'string' && /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(slug), 'invalid_slug');
      bounded(name, 80); text(idempotencyKey);
      return store.transaction(async tx => {
        const who = await credential(actor, tx);
        requireThat(who.kind === 'owner', 'scope_denied');
        const requestHash = digest({ slug, name }), key = digest({ principalId: who.principalId, idempotencyKey });
        const old = (await tx.read('project-requests', key))?.value;
        if (old) {
          requireThat(old.hash === requestHash, 'idempotency_conflict');
          return (await tx.read('projects', old.projectId)).value;
        }
        requireThat(!await tx.read('project-slugs', slug), 'slug_taken');
        await consumeProjects(tx);
      await capacity(tx, 'projects', who.principalId, 10);
        const id = opaque('prj_'), value = { id, slug, name, ownerId: who.principalId, createdAt: now(), archivedAt: null };
        await tx.write('projects', id, value, 0);
        await tx.write('project-slugs', slug, { projectId: id }, 0);
        await tx.write('project-requests', key, { hash: requestHash, projectId: id }, 0);
        await tx.write('memberships', who.principalId + ':' + id, { projectId: id, principalId: who.principalId }, 0);
        await tx.event({ type: 'project.created', projectId: id, at: now() });
        return value;
      });
    },
    async project(actor, projectId) {
      await authorize(actor, 'project.read', { projectId });
      const result = await store.read('projects', projectId);
      return { ...result.value, revision: result.revision };
    },
    async projects(actor, options = {}) {
      const who = await credential(actor);
      const links = await store.list('memberships', { ...options, prefix: who.principalId + ':' });
      const values = [];
      for (const link of links) if (await allowed(actor, 'project.read', { projectId: link.value.projectId }))
        values.push((await store.read('projects', link.value.projectId)).value);
      return { items: values, nextCursor: links.length === (options.limit ?? 100) ? links.at(-1).id : null };
    },
    async createAgent(actor, projectId, { name, idempotencyKey }) {
      bounded(name, 80);
      if (idempotencyKey !== undefined) text(idempotencyKey);
      return store.transaction(async tx => {
        const { project } = await owner(actor, projectId, tx);
        const key = idempotencyKey === undefined ? null : digest({ kind: 'agent', projectId, idempotencyKey });
        const old = key && await tx.read('identity-requests', key);
        if (old) {
          requireThat(old.value.hash === digest({ name }), 'idempotency_conflict');
          return (await tx.read('principals', old.value.id)).value;
        }
        requireThat(!project.transfer, 'project_transferred');
        requireThat(!(await tx.read('project-access', project.id))?.value.suspended && await writesEnabled(tx), 'project_unavailable');
        await capacity(tx, 'agents', projectId, 32);
        const id = opaque('agent_'), value = { id, name, projectId, kind: 'agent', createdAt: now() };
        await tx.write('principals', id, value, 0);
        await tx.write('memberships', id + ':' + projectId, { projectId, principalId: id }, 0);
        if (key) await tx.write('identity-requests', key, { id, hash: digest({ name }) }, 0);
        await tx.event({ type: 'agent.created', projectId, agentId: id, at: now() });
        return value;
      });
    },
    async grant(actor, projectId, { principalId, scopes, expiresAt, idempotencyKey }) {
      requireThat(Array.isArray(scopes) && scopes.length > 0 && scopes.length <= PROJECT_SCOPES.length &&
        scopes.every(s => PROJECT_SCOPES.includes(s)) && new Set(scopes).size === scopes.length, 'invalid_scopes');
      integer(expiresAt);
      if (idempotencyKey !== undefined) text(idempotencyKey);
      return store.transaction(async tx => {
        const { who, project } = await owner(actor, projectId, tx);
        const key = idempotencyKey === undefined ? null : digest({ kind: 'mandate', projectId, idempotencyKey });
        const hash = digest({ principalId, scopes: [...scopes].sort(), expiresAt });
        const old = key && await tx.read('identity-requests', key);
        if (old) {
          requireThat(old.value.hash === hash, 'idempotency_conflict');
          return (await tx.read('mandates', old.value.id)).value;
        }
        integer(expiresAt, now() + 1000, now() + MAX_MANDATE_TTL);
        requireThat(!project.transfer, 'project_transferred');
        requireThat(!(await tx.read('project-access', project.id))?.value.suspended && await writesEnabled(tx), 'project_unavailable');
        const agent = (await tx.read('principals', text(principalId)))?.value;
        requireThat(agent?.kind === 'agent' && agent.projectId === projectId, 'not_found');
        await capacity(tx, 'mandates-per-day', projectId + ':' + Math.floor(now() / 86400000), 64);
        const id = opaque('mnd_'), value = { id, projectId, principalId, ownerId: who.principalId,
          scopes: copy(scopes), expiresAt, revokedAt: null, createdAt: now() };
        await tx.write('mandates', id, value, 0);
        if (key) await tx.write('identity-requests', key, { id, hash }, 0);
        await tx.event({ type: 'mandate.granted', projectId, mandateId: id, at: now() });
        return value;
      });
    },
    async issueCredential(actor, { mandateId }) {
      const rawToken = token(), id = digest(rawToken);
      return store.transaction(async tx => {
        const mandate = (await tx.read('mandates', text(mandateId)))?.value;
        requireThat(mandate && !mandate.revokedAt && mandate.expiresAt > now(), 'not_found');
        const { project } = await owner(actor, mandate.projectId, tx);
        requireThat(!project.transfer, 'project_transferred');
        requireThat(!(await tx.read('project-access', project.id))?.value.suspended && await writesEnabled(tx), 'project_unavailable');
        await capacity(tx, 'credentials-per-day', mandate.projectId + ':' + Math.floor(now() / 86400000), 128);
        const value = { id, kind: 'agent', principalId: mandate.principalId, projectId: mandate.projectId,
          mandateId, scopes: mandate.scopes, createdAt: now(), expiresAt: mandate.expiresAt, revokedAt: null };
        await tx.write('credentials', id, value, 0);
        await tx.event({ type: 'credential.issued', projectId: value.projectId, credentialId: id, at: now() });
        return { token: rawToken, credential: publicCredential(value) };
      });
    },
    async rotate(actor, credentialId) {
      const rawToken = token(), id = digest(rawToken);
      return store.transaction(async tx => {
        const old = await tx.read('credentials', text(credentialId));
        requireThat(old && !old.value.revokedAt && old.value.expiresAt > now(), 'not_found');
        const caller = await credential(actor, tx);
        if (caller.id !== credentialId) await owner(actor, old.value.projectId, tx);
        if (old.value.kind === 'agent') {
          const mandate = (await tx.read('mandates', old.value.mandateId))?.value;
          requireThat(mandate && !mandate.revokedAt && mandate.expiresAt > now(), 'mandate_revoked');
        }
        const value = { ...old.value, id, createdAt: now() };
        await tx.write('credentials', id, value, 0);
        await tx.write('credentials', credentialId, { ...old.value, revokedAt: now() }, old.revision);
        await tx.event({ type: 'credential.rotated', projectId: value.projectId, credentialId, replacementId: id, at: now() });
        return { token: rawToken, credential: publicCredential(value) };
      });
    },
    async revoke(actor, kind, id) {
      requireThat(['mandate', 'credential'].includes(kind), 'invalid_kind');
      return store.transaction(async tx => {
        const collection = kind === 'mandate' ? 'mandates' : 'credentials';
        const old = await tx.read(collection, text(id));
        requireThat(old, 'not_found');
        if (kind === 'credential' && actor === id) await credential(actor, tx);
        else await owner(actor, old.value.projectId, tx);
        if (!old.value.revokedAt) {
          await tx.write(collection, id, { ...old.value, revokedAt: now() }, old.revision);
          await tx.event({ type: kind + '.revoked', projectId: old.value.projectId, id, at: now() });
        }
        return { id, revoked: true, alreadySentEffectsReversible: false };
      });
    }
  };
  return api;
}
