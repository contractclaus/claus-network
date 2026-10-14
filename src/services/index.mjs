import { randomBytes } from 'node:crypto';
import { amount, copy, digest, integer, requireThat, shape, text } from '../shared/index.mjs';
import { schemaDefinition, schemaValue, schemaSample } from './schema.mjs';
import { createPublicResults, PUBLIC_DATA_POLICY, PUBLIC_DATA_POLICY_HASH } from './public-results.mjs';
import { serviceProgress } from './progress.mjs';

export function createServices({ store, identity, artifacts, admit = async () => {}, admitPublicData = async () => { requireThat(false, 'public_data_not_enabled'); }, limit = async () => undefined, now = () => Date.now() }) {
  const results = createPublicResults({ store, identity, artifacts, enabled: admitPublicData, now });
  const scoped = (actor, scope, projectId, reader = store) => identity.authorize(actor, scope, { projectId }, reader);
  async function service(reader, id) {
    const row = await reader.read('service-versions', text(id)); requireThat(row, 'service_not_found'); return row;
  }
  async function availableProject(reader, projectId) {
    const project = (await reader.read('projects', projectId))?.value;
    return !!project && !project.transfer && !project.archivedAt && !(await reader.read('content-controls', projectId))?.value.held && !(await reader.read('project-access', projectId))?.value.suspended;
  }
  async function order(reader, projectId, id) {
    const row = await reader.read('service-orders', text(id));
    requireThat(row?.value.projectId === projectId, 'not_found'); return row;
  }
  async function capacity(tx, kind, subject, maximum) {
    maximum = await limit({ versions: 'serviceVersionsPerProject', quotes: 'quotesPerProjectDay', orders: 'ordersPerProjectDay' }[kind], tx) ?? maximum;
    const key = digest({ kind, subject }), row = await tx.read('service-capacity', key);
    requireThat((row?.value.count ?? 0) < maximum, 'capacity_reached');
    await tx.write('service-capacity', key, { count: (row?.value.count ?? 0) + 1 }, row?.revision ?? 0);
  }
  function manifest(value) {
    shape(value, ['name', 'capability', 'version', 'inputSchema', 'outputSchema', 'priceWei', 'recipient', 'maxDurationSeconds', 'validUntil', 'dataPolicy']);
    text(value.name); requireThat(value.name.length <= 80 && /^[a-z][a-z0-9.]{1,63}$/.test(value.capability) &&
      /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value.version) && /^0x[0-9a-fA-F]{40}$/.test(value.recipient) &&
      !/^0x0{40}$/.test(value.recipient) && ['no-delegation', PUBLIC_DATA_POLICY.id].includes(value.dataPolicy), 'invalid_service_manifest');
    requireThat(amount(value.priceWei) <= 2n * 10n ** 18n, 'invalid_service_price');
    integer(value.maxDurationSeconds, 30, 3600); integer(value.validUntil, now() + 60000, now() + 30 * 86400000);
    schemaDefinition(value.inputSchema); schemaDefinition(value.outputSchema); return copy(value);
  }
  function publicOrder(value) {
    const { buyerActor, leaseHash, ...result } = value; return result;
  }
  return {
    publishResult: results.publish, resultPublication: results.publication,
    publicResult: (id, reader) => results.read(id, reader), publicResultsForProject: results.forProject, publicResults: results.list,
    async version(actor, projectId, serviceId) {
      await scoped(actor, 'service.read', projectId); const value = (await service(store, serviceId)).value;
      requireThat(value.projectId === projectId, 'not_found');
      const publication = await store.read('service-publications', serviceId);
      return { ...value, publication: { published: publication?.value.published === true,
        revision: publication?.revision ?? 0 } };
    },
    async register(actor, projectId, value) {
      const clean = manifest(value), id = digest({ projectId, capability: clean.capability, version: clean.version });
      return store.transaction(async tx => {
        await scoped(actor, 'service.manage', projectId, tx);
        await admit(projectId,tx);
        if (clean.dataPolicy === PUBLIC_DATA_POLICY.id) await admitPublicData(projectId, tx);
        const old = await tx.read('service-versions', id);
        if (old) { requireThat(digest(old.value.manifest) === digest(clean), 'service_version_conflict'); return old.value; }
        await capacity(tx, 'versions', projectId, 64);
        const saved = { id, projectId, manifest: clean, manifestHash: digest(clean), state: 'proposed', createdAt: now() };
        await tx.write('service-versions', id, saved, 0); return saved;
      });
    },
    // The host creates a free, explicitly labelled transport probe. It proves
    // protocol/schema compatibility, not business accuracy or contract safety.
    async probe(serviceId) {
      return store.transaction(async tx => {
        const version = (await service(tx, serviceId)).value;
        requireThat(await availableProject(tx, version.projectId), 'service_not_available');
        requireThat(version.state === 'proposed', 'service_not_proposed');
        const id = digest({ kind: 'service-conformance', serviceId, manifestHash: version.manifestHash });
        const old = await tx.read('service-orders', id); if (old) return publicOrder(old.value);
        const inputHash = await artifacts.put(tx, version.projectId, schemaSample(version.manifest.inputSchema));
        const value = { id, projectId: version.projectId, providerProjectId: version.projectId, serviceId,
          purpose: 'conformance', manifestHash: version.manifestHash, inputHash, state: 'queued',
          payment: { state: 'not_required', amountWei: '0' }, acceptance: 'not_applicable',
          deadline: Math.min(now() + 3600000, version.manifest.validUntil), createdAt: now() };
        await tx.write('service-orders', id, value, 0); return publicOrder(value);
      });
    },
    async checkProbe(serviceId) {
      return store.transaction(async tx => {
        const row = await service(tx, serviceId), version = row.value;
        if (version.state !== 'proposed') return version;
        const id = digest({ kind: 'service-conformance', serviceId, manifestHash: version.manifestHash });
        const probe = (await tx.read('service-orders', id))?.value;
        if (!probe || !['delivered', 'expired'].includes(probe.state)) return version;
        if (probe.state === 'delivered') schemaValue(version.manifest.outputSchema, await artifacts.get(version.projectId, probe.outputHash, tx));
        const value = { ...version, state: probe.state === 'delivered' ? 'available' : 'rejected',
          compatibility: { manifestHash: version.manifestHash, suite: 'claus-pull-service-v1', runId: id,
            passed: probe.state === 'delivered', scope: 'transport-and-schema', outputHash: probe.outputHash ?? null } };
        await tx.write('service-versions', serviceId, value, row.revision); return value;
      });
    },
    // Host-only conformance result. Never exposed as a provider API method.
    async compatibility(serviceId, evidence) {
      shape(evidence, ['manifestHash', 'suite', 'runId', 'passed']);
      requireThat(evidence.suite === 'claus-pull-service-v1' && typeof evidence.passed === 'boolean', 'invalid_compatibility');
      text(evidence.runId);
      return store.transaction(async tx => {
        const row = await service(tx, serviceId);
        requireThat(row.value.state === 'proposed' && row.value.manifestHash === evidence.manifestHash, 'service_version_conflict');
        const value = { ...row.value, state: evidence.passed ? 'available' : 'rejected', compatibility: copy(evidence) };
        await tx.write('service-versions', serviceId, value, row.revision); return value;
      });
    },
    async publish(actor, projectId, { serviceId, published, expectedRevision }) {
      requireThat(typeof published === 'boolean', 'invalid_publication'); integer(expectedRevision);
      return store.transaction(async tx => {
        await identity.authorize(actor, 'project.publish', { projectId, withdrawal: !published }, tx); const row = await service(tx, serviceId);
        requireThat(row.value.projectId === projectId, 'not_found');
        if (published) requireThat(row.value.state === 'available' && row.value.manifest.validUntil > now(), 'service_not_available');
        const result = await tx.write('service-publications', serviceId, { published, projectId }, expectedRevision);
        const key=projectId+':'+serviceId, index=await tx.read('project-public-services',key);
        await tx.write('project-public-services',key,{serviceId,published},index?.revision??0);
        return { serviceId, published, revision: result.revision };
      });
    },
    async publicForProject(projectId) {
      if (!await availableProject(store, projectId)) return [];
      const rows=await store.list('project-public-services',{prefix:projectId+':',limit:100}),result=[];
      for(const row of rows)if(row.value.published){
        const value=(await service(store,row.value.serviceId)).value,m=value.manifest;
        if(value.state==='available'&&m.validUntil>now())result.push({id:value.id,name:m.name,capability:m.capability,
          version:m.version,priceWei:m.priceWei,chainId:11155111,expiresAt:m.validUntil,compatibility:'transport-and-schema'});
      }
      return result;
    },
    async discovery({ after = '', limit = 100 } = {}) {
      integer(limit, 1, 100); const rows = await store.list('service-publications', { after, limit });
      const result = [];
      for (const row of rows) if (row.value.published) {
        const value = (await service(store, row.id)).value;
        if (value.state === 'available' && value.manifest.validUntil > now() && await availableProject(store, value.projectId)) result.push(value);
      }
      return { services: result, nextCursor: rows.length === limit ? rows.at(-1).id : null };
    },
    async suspend(actor, projectId, serviceId) {
      return store.transaction(async tx => {
        await scoped(actor, 'service.manage', projectId, tx); const row = await service(tx, serviceId);
        requireThat(row.value.projectId === projectId, 'not_found');
        await tx.write('service-versions', serviceId, { ...row.value, state: 'suspended' }, row.revision);
        return { serviceId, state: 'suspended' };
      });
    },
    async quote(actor, projectId, { serviceId, input, idempotencyKey, sourceResults = [] }) {
      requireThat(Array.isArray(sourceResults), 'invalid_result_sources');
      text(idempotencyKey); const id = digest({ projectId, idempotencyKey, kind: 'service-quote' });
      const requestHash = digest({ serviceId, input, ...(sourceResults.length ? { sourceResults } : {}) });
      return store.transaction(async tx => {
        await scoped(actor, 'service.call', projectId, tx);
        await admit(projectId,tx);
        const old = await tx.read('service-quotes', id);
        if (old) { requireThat(old.value.requestHash === requestHash, 'idempotency_conflict'); return old.value; }
        const version = (await service(tx, serviceId)).value;
        const publication = (await tx.read('service-publications', serviceId))?.value;
        requireThat(publication?.published && version.state === 'available' && version.manifest.validUntil > now() &&
          await availableProject(tx, version.projectId), 'service_not_available');
        schemaValue(version.manifest.inputSchema, input);
        const publicData = version.manifest.dataPolicy === PUBLIC_DATA_POLICY.id;
        requireThat(Array.isArray(sourceResults) && (publicData || sourceResults.length === 0), 'result_policy_mismatch');
        if (publicData) await admitPublicData(projectId, tx);
        const lineage = await results.sources(tx, sourceResults);
        await capacity(tx, 'quotes', projectId + ':' + Math.floor(now() / 86400000), 64);
        const inputHash = await artifacts.put(tx, projectId, input);
        const value = { id, projectId, requestHash, serviceId, providerProjectId: version.projectId,
          manifestHash: version.manifestHash, inputHash, chainId: 11155111, asset: 'native',
          providerWei: version.manifest.priceWei, networkWei: '0', maximumWei: version.manifest.priceWei,
          recipient: version.manifest.recipient, dataPolicy: version.manifest.dataPolicy, settlement: 'direct-prepayment',
          ...(publicData ? { dataPolicyHash: PUBLIC_DATA_POLICY_HASH, ...lineage } : {}),
          maxDurationSeconds: version.manifest.maxDurationSeconds, expiresAt: Math.min(now() + 300000, version.manifest.validUntil), createdAt: now() };
        await tx.write('service-quotes', id, value, 0); return value;
      });
    },
    async accept(actor, projectId, quoteId) {
      return store.transaction(async tx => {
        await scoped(actor, 'service.call', projectId, tx);
        await admit(projectId,tx);
        const quote = (await tx.read('service-quotes', text(quoteId)))?.value;
        requireThat(quote?.projectId === projectId, 'not_found');
        const old = await tx.read('service-orders', quoteId); if (old) return publicOrder(old.value);
        const version = (await service(tx, quote.serviceId)).value;
        requireThat(version.state === 'available' && version.manifestHash === quote.manifestHash && quote.expiresAt > now() &&
          await availableProject(tx, version.projectId), 'quote_expired');
        if (quote.dataPolicy === PUBLIC_DATA_POLICY.id) { await admitPublicData(projectId, tx); await results.sources(tx, quote.sourceResults); }
        await capacity(tx, 'orders', projectId + ':' + Math.floor(now() / 86400000), 16);
        const free = quote.maximumWei === '0';
        const value = { id: quoteId, projectId, providerProjectId: quote.providerProjectId, serviceId: quote.serviceId,
          quoteHash: digest(quote), inputHash: quote.inputHash, buyerActor: actor, state: free ? 'queued' : 'awaiting_payment',
          ...(quote.dataPolicyHash ? { dataPolicyHash: quote.dataPolicyHash, manifestHash: quote.manifestHash, sourceResults: copy(quote.sourceResults) } : {}),
          payment: free ? { state: 'not_required', amountWei: '0' } : { state: 'pending', maximumWei: quote.maximumWei },
          acceptance: 'pending', deadline: Math.min(now() + quote.maxDurationSeconds * 1000, version.manifest.validUntil), createdAt: now() };
        await tx.write('service-orders', quoteId, value, 0); return publicOrder(value);
      });
    },
    // A payment adapter must independently validate the canonical chain receipt
    // against this exact quote before invoking this host-only transition.
    async paymentConfirmed(orderId, evidence) {
      shape(evidence, ['quoteHash', 'chainId', 'transactionHash', 'amountWei', 'recipient']);
      requireThat(evidence.chainId === 11155111 && /^0x[0-9a-f]{64}$/i.test(evidence.transactionHash), 'payment_mismatch');
      return store.transaction(async tx => {
        const row = await tx.read('service-orders', text(orderId)); requireThat(row, 'not_found');
        const quote = (await tx.read('service-quotes', orderId)).value;
        requireThat(evidence.quoteHash === row.value.quoteHash && evidence.amountWei === quote.maximumWei &&
          evidence.recipient.toLowerCase() === quote.recipient.toLowerCase(), 'payment_mismatch');
        if (row.value.payment.state === 'confirmed') { requireThat(digest(row.value.payment.evidence) === digest(evidence), 'payment_mismatch'); return publicOrder(row.value); }
        requireThat(row.value.payment.state === 'pending', 'payment_mismatch');
        const receiptId = evidence.chainId + ':' + evidence.transactionHash.toLowerCase();
        const receipt = await tx.read('service-payment-receipts', receiptId);
        requireThat(!receipt || receipt.value.orderId === orderId, 'receipt_already_used');
        if (!receipt) await tx.write('service-payment-receipts', receiptId, { orderId }, 0);
        const value = { ...row.value, payment: { state: 'confirmed', evidence: copy(evidence) },
          state: row.value.state === 'awaiting_payment' ? 'queued' : row.value.state };
        await tx.write('service-orders', orderId, value, row.revision); return publicOrder(value);
      });
    },
    async get(actor, projectId, orderId) {
      await scoped(actor, 'service.read', projectId);
      const value = (await store.read('service-orders', text(orderId)))?.value;
      requireThat(value && [value.projectId, value.providerProjectId].includes(projectId), 'not_found');
      return { ...publicOrder(value), progress: serviceProgress(value, now()) };
    },
    async authorizeOrder(actor, projectId, {orderId,quoteHash}) {
      return store.transaction(async tx=>{
        await scoped(actor,'service.call',projectId,tx);await admit(projectId,tx);
        const row=await order(tx,projectId,orderId);
        requireThat(row.value.purpose!=='conformance'&&row.value.quoteHash===quoteHash,'quote_input_mismatch');
        requireThat(['awaiting_payment','queued'].includes(row.value.state)&&row.value.deadline>now(),'service_order_busy');
        const value={...row.value,buyerActor:actor};
        await tx.write('service-orders',orderId,value,row.revision);
        await tx.event({type:'service.authority_changed',projectId,orderId,at:now()});
        return publicOrder(value);
      });
    },
    async paymentRequest(actor, projectId, orderId, reader = store) {
      await scoped(actor, 'service.call', projectId, reader);
      const value = (await order(reader, projectId, orderId)).value;
      requireThat(value.state === 'awaiting_payment' && value.deadline > now(), 'payment_not_pending');
      requireThat(await availableProject(reader, value.providerProjectId), 'service_not_available');
      const quote = (await reader.read('service-quotes', orderId)).value;
      return { order: publicOrder(value), quote };
    },
    async assigned(actor, providerProjectId, { after = '', limit = 100 } = {}) {
      await scoped(actor, 'service.provide', providerProjectId); integer(limit, 1, 100);
      const rows = await store.list('service-orders', { after, limit });
      return { orders: rows.filter(row => row.value.providerProjectId === providerProjectId &&
        ['queued', 'working'].includes(row.value.state)).map(row => publicOrder(row.value)),
        nextCursor: rows.length === limit ? rows.at(-1).id : null };
    },
    async claim(actor, providerProjectId, orderId) {
      return store.transaction(async tx => {
        await scoped(actor, 'service.provide', providerProjectId, tx);
        const row = await tx.read('service-orders', text(orderId));
        requireThat(row?.value.providerProjectId === providerProjectId, 'not_found');
        const value = row.value;
        requireThat(['queued', 'working'].includes(value.state) && (!value.leaseUntil || value.leaseUntil <= now()), 'service_order_busy');
        const version = (await service(tx, value.serviceId)).value;
        const probe = value.purpose === 'conformance';
        if (!probe && value.dataPolicyHash) { await admitPublicData(value.projectId, tx); await results.sources(tx, value.sourceResults); }
        if (value.deadline <= now() || version.state !== (probe ? 'proposed' : 'available') ||
            (!probe && !await identity.allowed(value.buyerActor, 'service.settle', { projectId: value.projectId }, tx))) {
          await tx.write('service-orders', orderId, { ...value, state: 'cancelled' }, row.revision);
          return { id: orderId, state: 'cancelled' };
        }
        const lease = randomBytes(24).toString('hex'), leaseUntil = Math.min(now() + 120000, value.deadline);
        const next = { ...value, state: 'working', leaseHash: digest(lease), leaseUntil };
        await tx.write('service-orders', orderId, next, row.revision);
        const input = await artifacts.get(value.projectId, value.inputHash, tx);
        return { ...publicOrder(next), lease, input };
      });
    },
    async deliver(actor, providerProjectId, { orderId, lease, output }) {
      const outputHash = digest(output);
      return store.transaction(async tx => {
        await scoped(actor, 'service.provide', providerProjectId, tx);
        const row = await tx.read('service-orders', text(orderId));
        requireThat(row?.value.providerProjectId === providerProjectId, 'not_found');
        const value = row.value;
        if (value.state === 'delivered' && value.leaseHash === digest(lease) && value.outputHash === outputHash) return publicOrder(value);
        requireThat(value.state === 'working' && value.leaseHash === digest(lease) && value.leaseUntil > now() && value.deadline > now(), 'lease_lost');
        if (value.dataPolicyHash) { await admitPublicData(value.projectId, tx); await results.sources(tx, value.sourceResults); }
        schemaValue((await service(tx, value.serviceId)).value.manifest.outputSchema, output);
        await artifacts.put(tx, value.projectId, output);
        const next = { ...value, state: 'delivered', outputHash, deliveredAt: now() };
        await tx.write('service-orders', orderId, next, row.revision); return publicOrder(next);
      });
    },
    async result(actor, projectId, orderId) {
      await scoped(actor, 'service.read', projectId);
      const value = (await store.read('service-orders', text(orderId)))?.value;
      requireThat(value && [value.projectId, value.providerProjectId].includes(projectId), 'not_found');
      requireThat(value.outputHash, 'result_not_ready'); return artifacts.get(value.projectId, value.outputHash);
    },
    async acceptResult(actor, projectId, { orderId, outputHash, accepted }) {
      requireThat(typeof accepted === 'boolean', 'invalid_acceptance');
      return store.transaction(async tx => {
        await scoped(actor, 'service.settle', projectId, tx); const row = await order(tx, projectId, orderId);
        requireThat(row.value.state === 'delivered' && row.value.outputHash === outputHash, 'result_mismatch');
        const acceptance = accepted ? 'accepted' : 'disputed';
        requireThat(row.value.acceptance === 'pending' || row.value.acceptance === acceptance, 'acceptance_conflict');
        const value = { ...row.value, acceptance }; await tx.write('service-orders', orderId, value, row.revision); return publicOrder(value);
      });
    },
    async cancel(actor, projectId, orderId) {
      return store.transaction(async tx => {
        await scoped(actor, 'service.settle', projectId, tx); const row = await order(tx, projectId, orderId);
        requireThat(row.value.purpose !== 'conformance', 'scope_denied');
        requireThat(['awaiting_payment', 'queued', 'cancelled'].includes(row.value.state), 'effect_requires_reconciliation');
        const value = { ...row.value, state: 'cancelled' }; await tx.write('service-orders', orderId, value, row.revision); return publicOrder(value);
      });
    },
    async expire({ after = '', limit = 100 } = {}) {
      integer(limit, 1, 100);
      return store.transaction(async tx => {
        const rows = await tx.list('service-orders', { after, limit }); let expired = 0;
        for (const row of rows) if (['awaiting_payment', 'queued', 'working'].includes(row.value.state) && row.value.deadline <= now()) {
          await tx.write('service-orders', row.id, { ...row.value, state: 'expired' }, row.revision);
          await tx.event({ type: 'service.order_expired', orderId: row.id, projectId: row.value.projectId, at: now() }); expired++;
        }
        return { expired, nextCursor: rows.length === limit ? rows.at(-1).id : null };
      });
    }
  };
}
