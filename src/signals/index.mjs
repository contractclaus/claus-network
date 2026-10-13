import { copy, digest, integer, requireThat, shape, text } from '../shared/index.mjs';

const word = x => typeof x === 'string' && /^0x[0-9a-f]{64}$/.test(x);
const address = x => typeof x === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x) && !/^0x0{40}$/.test(x);
const hex = (x, size) => typeof x === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(x) && x.length <= 2 + size * 2;
const view = row => { const { actor, config, ...value } = row.value; return { ...copy(value), revision: row.revision }; };

// A narrow companion to an existing reviewed evaluator. The API prepares
// exact calls and observes receipts; owners and publishers keep their keys.
export function createSignals({ store, identity, chain, artifacts, publicResult, now = () => Date.now() }) {
  function recordState(evidence) {
    if (!evidence.finalized) return 'unavailable';
    if (Number(evidence.record.sequence) === 0) return 'empty';
    if (typeof evidence.authorizationActive !== 'boolean' || !Number.isSafeInteger(evidence.currentVersion)) return 'unavailable';
    if (!evidence.authorizationActive) return 'withdrawn';
    if (evidence.currentVersion !== Number(evidence.record.version)) return 'superseded';
    return Number(evidence.record.validUntil)*1000 <= now() ? 'stale' : 'current';
  }
  async function binding(projectId, reader = store) {
    const b = (await reader.read('chain-bindings', projectId))?.value;
    requireThat(b?.profile === 'claus-readonly-v1' && [1,11155111].includes(b.chainId), 'project_not_registered');
    return b;
  }
  async function admission(chainId, reader = store) {
    const config = (await reader.read('network-capabilities', 'signal:' + chainId))?.value;
    requireThat(config?.enabled === true && config.profile === 'claus-signal-v1' && config.chainId === chainId &&
      config.expiresAt > now(), 'signal_not_enabled');
    requireThat(address(config.factory) && address(config.executor) && word(config.factoryCodeHash) &&
      word(config.feedId) && word(config.schemaHash), 'signal_admission_changed');
    const review = (await reader.read('review-cases', config.reviewCaseId))?.value;
    const assessment = (await reader.read('signal-admission-assessments', digest(config)))?.value;
    requireThat(assessment?.accepted === true && assessment.profileHash === digest(config) &&
      review?.state === 'reviewed' && review.projectId === config.artifactProjectId &&
      review.artifactHash === config.reviewArtifactHash && assessment.reviewArtifactHash === review.artifactHash &&
      assessment.factoryArtifactHash === config.factoryArtifactHash && assessment.storeArtifactHash === config.storeArtifactHash,
    'signal_scope_not_reviewed');
    await chain.validateAdmission(config,await artifacts.get(config.artifactProjectId,config.factoryArtifactHash,reader));
    return config;
  }
  async function signal(projectId, reader = store) {
    const s = (await reader.read('project-signals', projectId))?.value;
    requireThat(s?.state === 'verified', 'signal_store_not_registered'); return s;
  }
  async function owned(projectId, id, reader = store) {
    const row = await reader.read('signal-operations', text(id));
    requireThat(row?.value.projectId === projectId, 'not_found'); return row;
  }
  async function writeAllowed(actor, projectId, scope, reader = store) {
    await identity.authorize(actor, scope, { projectId }, reader);
    const b = await binding(projectId, reader), config = await admission(b.chainId, reader);
    requireThat(config.executor.toLowerCase() === b.executor.toLowerCase(), 'signal_admission_changed');
    return { binding: b, config };
  }
  async function source(input, reader = store) {
    shape(input.sourceResult, ['id','revision','outputHash']); integer(input.sourceResult.revision, 1);
    const result = await publicResult(input.sourceResult.id, reader);
    requireThat(result.revision === input.sourceResult.revision && result.outputHash === input.sourceResult.outputHash &&
      result.output.onchainData === input.data, 'signal_source_changed');
    return '0x' + digest(input.sourceResult).slice(7);
  }
  async function validateStoreBuild(config,observed) {
    await chain.validateStoreBuild(config,observed.signal,
      await artifacts.get(config.artifactProjectId,config.storeArtifactHash),
      await artifacts.get(config.artifactProjectId,config.factoryArtifactHash),observed.blockNumber);
  }
  async function prepare(actor, projectId, kind, input, build, { revoke = false } = {}) {
    text(input.idempotencyKey);
    const scope = kind === 'record' ? 'signal.publish' : revoke ? 'signal.grant.revoke' : 'signal.manage';
    await identity.authorize(actor, scope, { projectId });
    const id = digest({ projectId, kind: 'signal-' + kind, idempotencyKey: input.idempotencyKey }), requestHash = digest(input);
    const old = await store.read('signal-operations', id);
    if (old) { requireThat(old.value.requestHash === requestHash, 'idempotency_conflict'); return view(old); }
    const current = revoke ? { binding: await binding(projectId), config: (await signal(projectId)).config } : await writeAllowed(actor, projectId, scope);
    const prepared = await build(current);
    if(prepared.recovered)await validateStoreBuild(current.config,prepared);
    return store.transaction(async tx => {
      await identity.authorize(actor, scope, { projectId }, tx);
      const latest = revoke ? { binding: await binding(projectId, tx), config: current.config } : await writeAllowed(actor, projectId, scope, tx);
      requireThat(digest(latest) === digest(current), 'signal_admission_changed');
      const old = await tx.read('signal-operations', id);
      if (old) { requireThat(old.value.requestHash === requestHash, 'idempotency_conflict'); return view(old); }
      if (kind === 'store') {
        requireThat(!await tx.read('project-signals', projectId), 'signal_store_exists');
        requireThat(!await tx.read('project-vaults',projectId),'signal_review_context_changed');
        const claim=await tx.read('project-consumer-claims',projectId);
        requireThat(!claim||claim.value.profile==='claus-signal-v1','signal_review_context_changed');
        if(!claim)await tx.write('project-consumer-claims',projectId,{profile:'claus-signal-v1'},0);
        if(prepared.recovered) await tx.write('project-signals',projectId,{...prepared.signal,projectId,
          state:'verified',profile:'claus-signal-v1',config:current.config,binding:current.binding,
          artifactProjectId:current.config.artifactProjectId,artifactHash:current.config.storeArtifactHash,
          reviewArtifactHash:current.config.reviewArtifactHash,transactionHash:null,
          blockHash:prepared.blockHash,blockNumber:prepared.blockNumber,recovered:true,registeredAt:now()},0);
      }
      if (kind === 'record') {
        requireThat(!(await tx.read('signal-revocations', digest({ projectId, grantId: input.grantId }))), 'signal_api_revoked');
        await source(input, tx);
      }
      const capacityId = projectId + ':' + (revoke?'revoke:':'') + Math.floor(now() / 86400000), capacity = await tx.read('signal-capacity', capacityId);
      requireThat((capacity?.value.count ?? 0) < 128, 'capacity_reached');
      await tx.write('signal-capacity', capacityId, { projectId, count: (capacity?.value.count ?? 0) + 1 }, capacity?.revision ?? 0);
      return view(await tx.write('signal-operations', id, { id, projectId, actor, kind, requestHash, input: copy(input),
        ...current, ...prepared, state: prepared.recovered ? 'confirmed' : prepared.transaction ? 'prepared' : 'awaiting_signature',
        createdAt: now(), expiresAt: kind === 'record' ? input.validUntil * 1000 : now() + 86400000 }, 0));
    });
  }
  async function reconcile(row) {
    const action = row.value;
    if (!action.transactionHash || ['confirmed','failed'].includes(action.state)) return view(row);
    let observed;
    try { observed=await chain.observe(action,action.transactionHash); }
    catch(error) {
      if(error.code!=='signal_transaction_mismatch')throw error;
      observed={state:'failed',error:'signal_transaction_mismatch'};
    }
    if (observed.state === 'pending') return view(row);
    if(observed.state==='confirmed'&&action.kind==='store')await validateStoreBuild(action.config,observed);
    return store.transaction(async tx => {
      const latest = await owned(action.projectId, action.id, tx);
      if (['confirmed','failed'].includes(latest.value.state)) return view(latest);
      requireThat(latest.value.transactionHash === action.transactionHash, 'signal_transaction_mismatch');
      if (observed.state === 'confirmed' && action.kind === 'store') {
        const old = await tx.read('project-signals', action.projectId);
        requireThat(!old || old.value.address === observed.signal.address, 'signal_store_exists');
        if (!old) await tx.write('project-signals', action.projectId, { ...observed.signal, projectId: action.projectId,
          state: 'verified', profile: 'claus-signal-v1', config: action.config, binding: action.binding,
          artifactProjectId: action.config.artifactProjectId, artifactHash: action.config.storeArtifactHash,
          reviewArtifactHash: action.config.reviewArtifactHash, transactionHash: action.transactionHash,
          blockHash: observed.blockHash, blockNumber: observed.blockNumber, registeredAt: now() }, 0);
      }
      if (observed.state === 'confirmed' && action.kind === 'revoke') {
        const key = digest({ projectId: action.projectId, grantId: action.input.grantId });
        const prior = await tx.read('signal-revocations', key);
        await tx.write('signal-revocations', key, { ...prior.value, onchain: 'confirmed', transactionHash: action.transactionHash }, prior.revision);
      }
      await tx.event({ type: 'signal.' + action.kind + '_' + observed.state, projectId: action.projectId, operationId: action.id, at: now() });
      return view(await tx.write('signal-operations', action.id, { ...latest.value, ...observed, updatedAt: now() }, latest.revision));
    });
  }
  async function visible(projectId) {
    const p = (await store.read('projects', projectId))?.value;
    return p && !p.archivedAt && !p.transfer && !(await store.read('project-access', projectId))?.value.suspended &&
      (await store.read('public-projects', p.slug))?.value.published && (await store.read('signal-publications', projectId))?.value.published;
  }
  return {
    admission,
    async discovery(chainId) {
      try { const c = await admission(chainId); return { chainId, profile: c.profile, admission: 'public', expiresAt: c.expiresAt,
        factory: c.factory, factoryCodeHash: c.factoryCodeHash, feedId: c.feedId, schemaHash: c.schemaHash,
        publicationGas: 'publisher', maximumInputBytes: 2048, maximumOutputBytes: 512 }; }
      catch (error) { if (!['signal_not_enabled','signal_admission_changed','signal_scope_not_reviewed'].includes(error.code)) throw error;
        return { chainId, profile: 'claus-signal-v1', admission: 'not_enabled', reason: error.code }; }
    },
    storePrepare(actor, projectId, input) {
      shape(input, ['idempotencyKey']);
      return prepare(actor, projectId, 'store', input, async c => chain.prepareStore(c.config, c.binding));
    },
    async get(actor, projectId) {
      await identity.authorize(actor, 'signal.read', { projectId });
      const s = await signal(projectId), publication = await store.read('signal-publications', projectId);
      const { config, binding, ...value } = s;
      return { ...value, publication: { published: publication?.value.published === true, revision: publication?.revision ?? 0 } };
    },
    async grantPrepare(actor, projectId, input) {
      shape(input, ['publisher','maximumWrites','minimumInterval','expiresAt','nonce','idempotencyKey']);
      requireThat(address(input.publisher) && /^(0|[1-9][0-9]{0,77})$/.test(input.nonce) && BigInt(input.nonce) < 2n ** 256n, 'invalid_signal_grant');
      integer(input.maximumWrites,1,10000); integer(input.minimumInterval,1,7*86400);
      integer(input.expiresAt,Math.floor(now()/1000)+60,Math.floor(now()/1000)+30*86400);
      const { idempotencyKey, ...terms } = input;
      return prepare(actor, projectId, 'grant', input, async c => chain.prepareGrant(await signal(projectId), c.binding, terms));
    },
    async grantRegister(actor, projectId, { operationId, signature }) {
      const current = await writeAllowed(actor, projectId, 'signal.manage');
      const row = await owned(projectId, operationId);
      requireThat(row.value.kind === 'grant' && hex(signature,65), 'invalid_signature');
      const signatureHash = digest(signature);
      if (row.value.signatureHash) { requireThat(row.value.signatureHash === signatureHash, 'idempotency_conflict'); return view(row); }
      requireThat(row.value.expiresAt > now() && row.value.input.expiresAt * 1000 > now(), 'signal_operation_expired');
      const prepared = await chain.registerGrant(await signal(projectId), current.binding, row.value, signature);
      return store.transaction(async tx => {
        const latest = await writeAllowed(actor, projectId, 'signal.manage', tx);
        requireThat(digest(latest) === digest(current), 'signal_admission_changed');
        const prior = await owned(projectId, operationId, tx);
        if (prior.value.signatureHash) { requireThat(prior.value.signatureHash === signatureHash, 'idempotency_conflict'); return view(prior); }
        return view(await tx.write('signal-operations', operationId, { ...prior.value, ...prepared, signatureHash, state: 'prepared' }, prior.revision));
      });
    },
    async grant(actor, projectId, grantId) {
      await identity.authorize(actor, 'signal.read', { projectId }); requireThat(word(grantId), 'invalid_signal_grant');
      const s = await signal(projectId), g = await chain.grant(s, grantId);
      const revoked = (await store.read('signal-revocations', digest({ projectId, grantId })))?.value;
      return { ...g, apiRevoked: !!revoked, onchainRevocation: g.revoked ? 'confirmed' : revoked ? revoked.onchain : 'not_requested' };
    },
    async revoke(actor, projectId, input) {
      shape(input, ['grantId','idempotencyKey']); requireThat(word(input.grantId), 'invalid_signal_grant'); text(input.idempotencyKey);
      await store.transaction(async tx => {
        await identity.authorize(actor, 'signal.grant.revoke', { projectId }, tx);
        await signal(projectId, tx);
        const id = digest({ projectId, grantId: input.grantId });
        if (!await tx.read('signal-revocations', id)) {
          const key=projectId+':'+Math.floor(now()/86400000),cap=await tx.read('signal-revocation-capacity',key);
          requireThat((cap?.value.count??0)<128,'capacity_reached');
          await tx.write('signal-revocation-capacity',key,{projectId,count:(cap?.value.count??0)+1},cap?.revision??0);
          await tx.write('signal-revocations',id,{projectId,grantId:input.grantId,revokedAt:now(),onchain:'not_submitted'},0);
        }
      });
      return prepare(actor, projectId, 'revoke', input, async c =>
        chain.prepareRevoke(await signal(projectId), c.binding, input.grantId), { revoke: true });
    },
    async recordPrepare(actor, projectId, input) {
      shape(input, ['grantId','sequence','expectedVersion','observedAt','validUntil','sourceResult','data','idempotencyKey']);
      requireThat(word(input.grantId) && hex(input.data,2048), 'invalid_signal_record');
      for (const k of ['sequence','expectedVersion','observedAt']) integer(input[k],1);
      integer(input.validUntil,Math.floor(now()/1000)+1,input.observedAt+86400);
      requireThat(input.observedAt <= Math.floor(now()/1000), 'invalid_signal_record');
      return prepare(actor, projectId, 'record', input, async c => {
        const sourceHash = await source(input);
        requireThat(!(await store.read('signal-revocations', digest({ projectId, grantId: input.grantId }))), 'signal_api_revoked');
        return { ...await chain.prepareRecord(await signal(projectId), c.binding, { ...input, sourceHash }), sourceHash };
      });
    },
    async submit(actor, projectId, { operationId, transactionHash }) {
      requireThat(word(transactionHash), 'invalid_transaction_hash');
      await identity.authorize(actor,'signal.read',{projectId});
      const pending=await owned(projectId,operationId);
      requireThat(pending.value.transaction,'signal_signature_required');
      requireThat(pending.value.transactionHash||pending.value.actor===actor||(await identity.credential(actor)).kind==='owner','scope_denied');
      // Reject a provably wrong hash before making it the permanent receipt.
      // Unknown hashes remain attached and are never replaced or cancelled.
      if(!pending.value.transactionHash)await chain.observe(pending.value,transactionHash);
      const row = await store.transaction(async tx => {
        // Receipt recovery remains available after admission or grant expiry.
        await identity.authorize(actor, 'signal.read', { projectId }, tx);
        const row = await owned(projectId, operationId, tx);
        requireThat(row.value.transaction, 'signal_signature_required');
        requireThat(row.value.transactionHash || row.value.actor === actor ||
          (await identity.credential(actor, tx)).kind === 'owner', 'scope_denied');
        if (row.value.transactionHash) { requireThat(row.value.transactionHash === transactionHash, 'signal_transaction_conflict'); return row; }
        return tx.write('signal-operations', operationId, { ...row.value, transactionHash, state: 'pending', submittedAt: now() }, row.revision);
      });
      return reconcile(row);
    },
    async operation(actor, projectId, id) {
      await identity.authorize(actor, 'signal.read', { projectId }); return reconcile(await owned(projectId, id));
    },
    async latest(actor, projectId) {
      await identity.authorize(actor, 'signal.read', { projectId });
      const s = await signal(projectId), evidence = await chain.latest(s);
      return { projectId, address: s.address, chainId: s.chainId, ...evidence,
        state: recordState(evidence) };
    },
    async publish(actor, projectId, { published, expectedRevision }) {
      requireThat(typeof published === 'boolean', 'invalid_publication'); integer(expectedRevision);
      return store.transaction(async tx => {
        await identity.authorize(actor,'project.publish',{projectId,withdrawal:!published},tx); await signal(projectId,tx);
        const row = await tx.write('signal-publications',projectId,{projectId,published},expectedRevision);
        return { projectId,published,revision:row.revision };
      });
    },
    async public(projectId) {
      requireThat(await visible(projectId), 'not_found');
      const s = await signal(projectId);
      const value = { projectId, profile: s.profile, chainId: s.chainId, address: s.address, codeHash: s.codeHash,
        factory: s.factory, evaluator: s.evaluator, feedId: s.feedId, schemaHash: s.schemaHash, transactionHash: s.transactionHash };
      try { const evidence = await chain.latest(s); return { ...value, ...evidence,
        state: recordState(evidence) }; }
      catch { return { ...value, state: 'unavailable' }; }
    },
    async publicForProject(projectId) {
      if (!await visible(projectId)) return [];
      const s = await signal(projectId);
      return [{ projectId, profile: s.profile, chainId: s.chainId, address: s.address, codeHash: s.codeHash,
        feedId: s.feedId, schemaHash: s.schemaHash, href: '/v1/public/signals/' + projectId }];
    },
    async consumer(projectId, reader = store) {
      const s = (await reader.read('project-signals', projectId))?.value;
      const b=(await reader.read('chain-bindings',projectId))?.value;
      const config=b&&(await reader.read('network-capabilities','signal:'+b.chainId))?.value;
      if(config?.factory)await chain.assertTrackedStore(config,b,s);
      if (!s) return null;
      return { signal: s, build: await artifacts.get(s.artifactProjectId, s.artifactHash, reader),
        factoryBuild: await artifacts.get(s.artifactProjectId, s.config.factoryArtifactHash, reader),
        review: await artifacts.get(s.artifactProjectId, s.reviewArtifactHash, reader) };
    }
  };
}
