import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { canonical, contentHash, copy, digest, integer, requireThat, shape, text } from '../shared/index.mjs';

const SCHEMA = 'claus-project-archive/1';
const MAX_BYTES = 64000000, MAX_RECORDS = 40000, PAGE_SIZE = 100, PAGE_BYTES = 200000;
// An explicit inventory prevents new runtime tables, credentials or signed
// transaction material from silently becoming part of an export.
const FIELDS = Object.freeze({
  'project-runtimes': 'projectId runtimeId workerId workerRevision intervalSeconds maxCycles memory observation cycle state updatedAt',
  'project-workers': 'projectId workerId snapshotId entry paths sourceHash enabled updatedAt',
  'worker-runs': 'id projectId workerId definitionRevision state createdAt startedAt finishedAt resultJson error provider exitCode',
  snapshots: 'id projectId files createdAt',
  artifacts: 'projectId path content hash',
  builds: 'id projectId jobId snapshotId entry contract compilerProfile sourceRoot requestHash state artifactHash admissionVersion createdAt completedAt evidenceLevel error',
  'review-cases': 'chainId profile id projectId buildId input inputHash state quoteJobId quoteId reviewJobId executionJobId artifactHash providerJobId sourceBinding createdAt',
  'review-quotes': 'id projectId inputHash requestHash offer policyRefs feeTerms sponsored sponsorAccount projectAccount maximum',
  'review-jobs': 'id projectId quoteId inputHash requestHash work billing maximum policyRefs cancelledAt reason providerJobId completedAt artifactHash actual costReceiptId',
  'inference-requests': 'id projectId requestHash inputHash profileHash jobId work billing actual providerRequestId outputHash receiptHash createdAt',
  'contract-bindings': 'id projectId requester expiresAt maxRequests chainId inbox codeHash capability configHash used revokedAt createdAt',
  'contract-requests': 'id projectId bindingId jobId observation observationHash state proposalId result delivery error createdAt updatedAt',
  'chain-modules': 'profile id projectId caseId buildId artifactHash state jobId chainId expiresAt createdAt updatedAt address transactionHash codeHash verification error',
  'chain-registrations': 'profile executor configuration observedBlock id projectId moduleId mandateId domain types primaryType message state createdAt jobId chainId address transactionHash codeHash verification binding error updatedAt',
  'chain-bindings': 'projectId registrationId moduleId chainId target executor owner projectKey profile minDelaySeconds transactionHash codeHash verification',
  'chain-proposals': 'id projectId requestHash moduleId caseId proposal proposalHash reviewArtifactHash inputArtifactHash state createdAt updatedAt decisionJobId executionJobId decision review execution error queueTransaction executionTransaction readyAt',
  'project-wallets': 'projectId owner attempt chainId profile state actionId address transactionHash codeHash verification error updatedAt',
  'wallet-actions': 'id projectId kind request state jobId createdAt updatedAt transactionHash address codeHash verification paymentEvidence error',
  'wallet-sessions': 'id projectId wallet typedData state createdAt',
  'wallet-payments': 'id projectId orderId wallet typedData signer state createdAt',
  'project-signals': 'projectId state profile chainId address codeHash factory factoryCodeHash evaluator executor projectKey feedId schemaHash artifactProjectId artifactHash reviewArtifactHash transactionHash blockHash blockNumber registeredAt recovered',
  'signal-operations': 'id projectId kind requestHash input binding state createdAt expiresAt updatedAt transactionHash submittedAt blockHash blockNumber finalized error sourceHash grantId typedData recovered',
  'signal-revocations': 'projectId grantId revokedAt onchain transactionHash',
  'signal-publications': 'projectId published',
  'project-vaults': 'projectId owner chainId profile attempt policy artifactProjectId artifactHash reviewArtifactHash state jobId createdAt updatedAt address transactionHash codeHash verification error',
  'service-versions': 'id projectId manifest manifestHash state createdAt compatibility',
  'service-quotes': 'id projectId requestHash serviceId providerProjectId manifestHash inputHash chainId asset providerWei networkWei maximumWei recipient dataPolicy dataPolicyHash sourceResults depth settlement maxDurationSeconds expiresAt createdAt',
  'service-orders': 'id projectId providerProjectId serviceId purpose manifestHash quoteHash inputHash state payment acceptance deadline createdAt outputHash completedAt deliveredAt attempts dataPolicyHash sourceResults',
  'project-releases': 'id projectId snapshotId paths createdAt contentHash url isolation',
  'public-projects': 'projectId slug name description published updatedAt',
  'public-sources': 'projectId snapshotId published files',
  'service-publications': 'projectId published',
  'service-result-publications': 'projectId orderId outputHash published expiresAt publishedAt sourceResults depth',
  'release-publications': 'projectId published expiresAt updatedAt',
  'imported-history': 'projectId archiveId header pages',
  'workflow-jobs': 'id projectId kind requestHash state effect effectKey attempts availableAt createdAt updatedAt result'
});
const PRIVATE_FIELDS = new Set(['actor', 'authority', 'buyerActor', 'lease', 'leaseHash', 'signature',
  'approvalSignature', 'ownerSignature', 'signedTransaction', 'rawTransaction', 'privateKey',
  'accessToken', 'refreshToken', 'credential', 'credentialId', 'replacementId', 'secret', 'sealed']);
const OMITTED = Object.freeze([
  'Runtime credentials, private keys, live leases and reusable signatures',
  'Provider accounts, operator-wide balances, sponsorship grants and spending authority',
  'Derived indexes and runtime scheduling cursors',
  'Collections not explicitly listed in coverage'
]);
const select = (value, names) => Object.fromEntries(names.split(' ').filter(k => Object.hasOwn(value, k)).map(k => [k, value[k]]));
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !PRIVATE_FIELDS.has(key)).map(([key, item]) => [key, redact(item)]));
  return value;
}
function origin(value) {
  const parsed = new URL(value);
  requireThat(parsed.protocol === 'https:' && parsed.origin === value && !parsed.username && !parsed.password, 'invalid_operator');
  return value;
}
function publicKey(value) {
  const key = value?.type === 'public' ? value : createPublicKey(value);
  requireThat(key.asymmetricKeyType === 'ed25519', 'invalid_archive_key');
  return key;
}
export function archiveKeyId(key) {
  return digest(publicKey(key).export({ type: 'spki', format: 'der' }).toString('base64'));
}
async function all(reader, collection, accept, add) {
  let after = '';
  for (;;) {
    const rows = await reader.list(collection, { after, limit: 1000 });
    for (const row of rows) if (accept(row)) await add(row);
    if (rows.length < 1000) return;
    after = rows.at(-1).id;
  }
}

export function createProjectArchives({ store, identity, operatorId, signingKey, now = () => Date.now() }) {
  origin(operatorId);
  const key = signingKey?.type === 'private' ? signingKey : createPrivateKey(signingKey);
  requireThat(key.asymmetricKeyType === 'ed25519', 'invalid_archive_key');
  const keyId = archiveKeyId(key);
  return {
    // A snapshot only. It grants no destination authority and does not migrate
    // a live job. Handover is a separate, fenced protocol.
    async export(actor, projectId, { reader = null, transfer = null } = {}) {
      const capture = async tx => {
        await identity.authorize(actor, 'project.export', { projectId }, tx);
        const project = await tx.read('projects', projectId);
        const owner = (await tx.read('principals', project.value.ownerId))?.value;
        requireThat(owner && /^0x[0-9a-f]{40}$/i.test(owner.address), 'archive_owner_missing');
        const records = [], jobIds = new Set(), caseIds = new Set(), chunkIds = new Set(), offerIds = new Set();
        let bytes = 0;
        function add(collection, row, value = row.value, projection = 'complete') {
          const record = { collection, id: row.id, revision: row.revision, projectId,
            originalHash: digest(row.value), projection, value: copy(value) };
          bytes += Buffer.byteLength(canonical(record));
          requireThat(bytes <= MAX_BYTES && records.length < MAX_RECORDS, 'archive_too_large');
          records.push(record);
        }
        add('projects', { id: projectId, ...project });
        for (const [collection, fields] of Object.entries(FIELDS)) {
          await all(tx, collection, row => row.value.projectId === projectId, row => {
            // An imported header's Ed25519 signature is public attestation,
            // not reusable wallet authority. Keep it for subsequent moves.
            const value = ['artifacts', 'snapshots', 'imported-history'].includes(collection)
              ? select(row.value, fields) : redact(select(row.value, fields));
            add(collection, row, value, digest(value) === digest(row.value) ? 'complete' : 'safe-fields');
            if (collection === 'review-jobs') jobIds.add(row.id);
            if (collection === 'review-cases') caseIds.add(row.id);
            if (collection === 'review-quotes') offerIds.add(row.value.offer.id);
          });
        }
        await all(tx, 'cost-receipts', row => jobIds.has(row.value.jobId), row => add('cost-receipts', row));
        // These publications are indexed by case/proposal ID rather than owner.
        const proposalIds = new Set(records.filter(r => r.collection === 'chain-proposals').map(r => r.id));
        const actionIds = new Set(records.filter(r => r.collection === 'wallet-actions').map(r => r.id));
        const contractRequestIds = new Set(records.filter(r => r.collection === 'contract-requests').map(r => r.id));
        await all(tx, 'imd-payments', row => offerIds.has(row.id), row => add('imd-payments', row,
          select(row.value, 'id offerId state amount payer updatedAt paymentHash'), 'safe-fields'));
        await all(tx, 'chain-transactions', row => {
          const scope = row.value.intent?.authority;
          return scope && (scope.projectId === projectId || proposalIds.has(scope.proposalId) || actionIds.has(scope.actionId) ||
            (scope.kind === 'contract-result' && contractRequestIds.has(scope.requestId)));
        }, row => {
          const scope = row.value.intent.authority;
          const value = select(row.value, 'id intentHash sender nonce state hash gas maxFeePerGas createdAt submittedAt completedAt receipt');
          if (scope.kind === 'contract-result' && contractRequestIds.has(scope.requestId)) {
            value.contractRequestId = scope.requestId;
            value.deliveryAction = scope.action;
          }
          add('chain-transactions', row, value, 'safe-fields');
        });
        for (const [collection, ids] of [['review-publications', caseIds], ['proposal-publications', proposalIds]]) {
          await all(tx, collection, row => ids.has(row.id), row => add(collection, row));
        }
        await all(tx, 'artifact-manifests', row => row.value.projectId === projectId, row => {
          add('artifact-manifests', row);
          row.value.chunks.forEach(id => chunkIds.add(id));
        });
        for (const id of [...chunkIds].sort()) {
          const row = await tx.read('artifact-chunks', id);
          requireThat(row && digest({ projectId, data: row.value.data }) === id, 'artifact_corrupt');
          add('artifact-chunks', { id, ...row });
        }
        let after = 0, highWatermark = 0;
        for (;;) {
          const events = await tx.events({ after, limit: 1000 });
          for (const event of events) {
            highWatermark = event.sequence;
            if (event.projectId === projectId) {
              add('events', { id: String(event.sequence), revision: 1, value: event }, redact(event), 'safe-fields');
            }
          }
          if (events.length < 1000) break;
          after = events.at(-1).sequence;
        }
        records.sort((a, b) => a.collection.localeCompare(b.collection, 'en') || a.id.localeCompare(b.id, 'en'));
        const pages = [];
        let page = [], pageBytes = 2;
        for (const record of records) {
          const size = Buffer.byteLength(canonical(record)) + 1;
          if (page.length && (page.length === PAGE_SIZE || pageBytes + size > PAGE_BYTES)) {
            pages.push(page); page = []; pageBytes = 2;
          }
          requireThat(size <= PAGE_BYTES, 'archive_record_too_large');
          page.push(record); pageBytes += size;
        }
        if (page.length) pages.push(page);
        const manifest = { schema: SCHEMA, purpose: transfer ? 'source-fenced-transfer' : 'snapshot-only', ...(transfer ? { transfer } : {}), operatorId, keyId, projectId,
          owner: { address: owner.address.toLowerCase(), chainId: owner.chainId }, createdAt: now(),
          highWatermark, recordCount: records.length, contentBytes: bytes,
          pages: pages.map(digest), coverage: [...Object.keys(FIELDS), 'projects', 'cost-receipts',
            'review-publications', 'proposal-publications', 'artifact-manifests', 'artifact-chunks', 'imd-payments', 'chain-transactions', 'events'],
          omitted: [...OMITTED], pendingEffects: records.filter(r => r.collection === 'workflow-jobs' &&
            !['complete', 'failed', 'cancelled'].includes(r.value.state)).map(r => ({ id: r.id,
              kind: r.value.kind, state: r.value.state, effect: r.value.effect, effectKey: r.value.effectKey,
              disposition: 'retain-at-source; reconcile original identity; never re-purchase' })).concat(
              records.filter(r => r.collection === 'signal-operations' && r.value.transactionHash &&
                !['confirmed','failed'].includes(r.value.state)).map(r => ({ id:r.id,kind:'signal-transaction',state:r.value.state,
                effect:'outcome_unknown',effectKey:r.id,transactionHash:r.value.transactionHash,
                disposition:'retain-at-source; reconcile original transaction; never re-sign or reactivate grants at destination' })),
              records.filter(r => r.collection === 'contract-requests' && r.value.state === 'result_ready' &&
                !['delivered', 'closed', 'failed'].includes(r.value.delivery?.state)).map(r => ({
                id: r.id, kind: 'contract-result-delivery', state: r.value.delivery?.state ?? 'pending',
                effect: 'result_pending', effectKey: r.id,
                disposition: 'retain-at-source; reconcile original request and transactions; never re-dispatch at destination'
              })),
              records.filter(r => r.collection === 'chain-transactions' && r.value.contractRequestId &&
                !['confirmed', 'reverted', 'cancelled'].includes(r.value.state)).map(r => ({
                id: r.id, kind: 'contract-result-transaction', state: r.value.state,
                effect: 'outcome_unknown', effectKey: r.id, transactionHash: r.value.hash,
                disposition: 'retain-at-source; reconcile original transaction; never re-sign at destination'
              }))) };
        const signature = sign(null, Buffer.from(canonical(manifest)), key).toString('base64');
        return { id: digest(manifest), manifest, signature, pages };
      };
      return reader ? capture(reader) : store.transaction(capture);
    }
  };
}

export function verifyProjectArchive(archive, { trustedOperators, expectedOwner }) {
  shape(archive, ['id', 'manifest', 'signature', 'pages']);
  const { manifest, pages } = archive;
  verifyArchiveHeader(archive, { trustedOperators, expectedOwner });
  requireThat(Array.isArray(pages) && pages.length === manifest.pages.length && pages.length <= 1000,
    'archive_pages_mismatch');
  const records = [], seen = new Set(); let bytes = 0;
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    requireThat(Array.isArray(page) && page.length > 0 && page.length <= PAGE_SIZE && digest(page) === manifest.pages[i], 'archive_page_corrupt');
    for (const record of page) {
      shape(record, ['collection', 'id', 'revision', 'projectId', 'originalHash', 'projection', 'value']);
      requireThat(manifest.coverage.includes(record.collection) && record.projectId === manifest.projectId &&
        ['complete', 'safe-fields'].includes(record.projection), 'archive_record_mismatch');
      if (record.value.projectId) requireThat(record.value.projectId === manifest.projectId, 'archive_record_mismatch');
      text(record.id); integer(record.revision, 1); contentHash(record.originalHash);
      const id = record.collection + ':' + record.id;
      requireThat(!seen.has(id), 'archive_duplicate_record'); seen.add(id);
      if (record.projection === 'complete') requireThat(digest(record.value) === record.originalHash, 'archive_record_corrupt');
      bytes += Buffer.byteLength(canonical(record));
      requireThat(bytes <= MAX_BYTES && records.length < MAX_RECORDS, 'archive_too_large');
      records.push(record);
    }
  }
  requireThat(bytes === manifest.contentBytes && records.length === manifest.recordCount, 'archive_inventory_mismatch');
  const project = records.filter(r => r.collection === 'projects');
  requireThat(project.length === 1 && project[0].id === manifest.projectId && project[0].value.id === manifest.projectId,
    'archive_project_mismatch');
  return { id: archive.id, manifest: copy(manifest), records, authority: 'historical-only' };
}

export function verifyArchiveHeader(archive, { trustedOperators, expectedOwner }) {
  const { manifest } = archive;
  requireThat(manifest && typeof manifest === 'object', 'invalid_shape');
  shape(manifest, ['schema', 'purpose', 'operatorId', 'keyId', 'projectId', 'owner', 'createdAt',
    'highWatermark', 'recordCount', 'contentBytes', 'pages', 'coverage', 'omitted', 'pendingEffects', ...(manifest.purpose === 'source-fenced-transfer' ? ['transfer'] : [])]);
  requireThat(manifest.schema === SCHEMA && ['snapshot-only', 'source-fenced-transfer'].includes(manifest.purpose), 'unsupported_archive');
  origin(manifest.operatorId); contentHash(manifest.keyId); contentHash(archive.id); text(manifest.projectId);
  const trusted = trustedOperators?.[manifest.operatorId]?.[manifest.keyId];
  requireThat(trusted, 'untrusted_archive_operator');
  const key = publicKey(trusted);
  requireThat(archiveKeyId(key) === manifest.keyId, 'archive_key_mismatch');
  requireThat(typeof archive.signature === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(archive.signature), 'invalid_archive_signature');
  requireThat(digest(manifest) === archive.id && verify(null, Buffer.from(canonical(manifest)), key,
    Buffer.from(archive.signature, 'base64')), 'invalid_archive_signature');
  shape(manifest.owner, ['address', 'chainId']);
  requireThat(expectedOwner && manifest.owner.address === expectedOwner.address?.toLowerCase() &&
    manifest.owner.chainId === expectedOwner.chainId, 'archive_owner_mismatch');
  integer(manifest.createdAt); integer(manifest.highWatermark); integer(manifest.recordCount, 1, MAX_RECORDS);
  integer(manifest.contentBytes, 1, MAX_BYTES);
  if (manifest.purpose === 'source-fenced-transfer') {
    shape(manifest.transfer, ['id', 'destination', 'fencedAt']);
    contentHash(manifest.transfer.id); origin(manifest.transfer.destination); integer(manifest.transfer.fencedAt);
    requireThat(manifest.transfer.destination !== manifest.operatorId, 'invalid_transfer_destination');
  }
  requireThat(Array.isArray(manifest.pages) && manifest.pages.length > 0 && manifest.pages.length <= 1000, 'archive_pages_mismatch');
  manifest.pages.forEach(contentHash);
  return manifest;
}
