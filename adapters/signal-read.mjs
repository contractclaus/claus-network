import { encodeFunctionData, hashTypedData, keccak256, parseAbi, verifyTypedData } from 'viem';
import { requireThat } from '../src/shared/index.mjs';
import { ClausApprovalExecutorAbi as executorAbi, ClausReadonlyProjectAbi as targetAbi } from './chain-abi.mjs';

export const factoryAbi = parseAbi([
  'function executor() view returns (address)',
  'function stores(bytes32) view returns (address)',
  'function create(bytes32 projectId,bytes32 feedId,bytes32 schemaHash) returns (address)'
]);
export const signalAbi = parseAbi([
  'function executor() view returns (address)', 'function evaluator() view returns (address)',
  'function projectId() view returns (bytes32)', 'function feedId() view returns (bytes32)', 'function schemaHash() view returns (bytes32)',
  'function registerGrant((address publisher,uint64 authorityGeneration,uint64 maximumWrites,uint64 minimumInterval,uint64 expiresAt,uint256 nonce) g,bytes signature) returns (bytes32)',
  'function grant(bytes32) view returns (((address publisher,uint64 authorityGeneration,uint64 maximumWrites,uint64 minimumInterval,uint64 expiresAt,uint256 nonce) terms,uint64 used,uint64 lastWrite,bool revoked))',
  'function latest() view returns ((bytes32 grantId,uint64 sequence,uint64 version,uint64 observedAt,uint64 validUntil,bytes32 sourceHash,bytes output))',
  'function revokeGrant(bytes32 id)',
  'function grantNonces(address,uint256) view returns (bool)',
  'function publish(bytes32 grantId,uint64 sequence,uint64 expectedVersion,uint64 observedAt,uint64 validUntil,bytes32 sourceHash,bytes data)'
]);
export const grantTypes = { PublisherGrant: [
  ['projectId','bytes32'], ['feedId','bytes32'], ['schemaHash','bytes32'], ['publisher','address'],
  ['authorityGeneration','uint64'], ['maximumWrites','uint64'], ['minimumInterval','uint64'], ['expiresAt','uint64'], ['nonce','uint256']
].map(([name,type]) => ({ name,type })) };
const zero = value => /^0x0{40}$/i.test(value);
const lower = value => value?.toLowerCase();
const safe = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v));
const intent = (chainId, from, to, data) => ({ chainId, from: lower(from), to: lower(to), value: '0', data: data.toLowerCase() });

// Read and exact-call preparation only. The owner/publisher signs locally;
// this adapter never receives a private key or broadcasts a transaction.
export function createSignalRead({ client, chainId }) {
  requireThat([1, 11155111].includes(chainId), 'unsupported_chain');
  const read = (address, abi, functionName, args = [], blockNumber) =>
    client.readContract({ address, abi, functionName, args, ...(blockNumber === undefined ? {} : { blockNumber }) });
  async function correct() { requireThat(await client.getChainId() === chainId, 'wrong_chain'); }
  async function eoa(address, blockNumber) {
    const code = await client.getCode({ address, ...(blockNumber === undefined ? {} : { blockNumber }) });
    requireThat(!code || code === '0x', 'signal_eoa_required');
  }
  async function factory(config, blockNumber) {
    await correct();
    requireThat(config.chainId === chainId && keccak256(await client.getCode({ address: config.factory,
      ...(blockNumber === undefined ? {} : { blockNumber }) })) === config.factoryCodeHash &&
      lower(await read(config.factory, factoryAbi, 'executor', [], blockNumber)) === lower(config.executor), 'signal_factory_changed');
  }
  async function state(binding, active = true, blockNumber) {
    await correct();
    const p = await read(binding.executor, executorAbi, 'projects', [binding.projectKey], blockNumber);
    requireThat(lower(p[1]) === lower(binding.target), 'project_binding_changed');
    if (active) {
      requireThat(p[7] && zero(await read(binding.executor, executorAbi, 'pendingProjectOwners', [binding.projectKey], blockNumber)), 'project_suspended');
      requireThat(lower(p[0]) === lower(binding.owner), 'project_binding_changed');
    }
    return { owner: lower(p[0]), authorityGeneration: Number(p[6]),
      version: Number(await read(binding.target, targetAbi, 'version', [], blockNumber)) };
  }
  async function store(config, binding, address, blockNumber) {
    await factory(config, blockNumber);
    const actual = await read(config.factory, factoryAbi, 'stores', [binding.projectKey], blockNumber);
    requireThat(!zero(actual) && lower(actual) === lower(address), 'signal_store_mismatch');
    const names = ['executor','evaluator','projectId','feedId','schemaHash'];
    const values = await Promise.all(names.map(name => read(address, signalAbi, name, [], blockNumber)));
    requireThat(values.every((v,i) => lower(v) === lower([binding.executor,binding.target,binding.projectKey,config.feedId,config.schemaHash][i])), 'signal_store_mismatch');
    const code = await client.getCode({ address, ...(blockNumber === undefined ? {} : { blockNumber }) });
    requireThat(code && code !== '0x', 'signal_store_mismatch');
    return { address: lower(address), codeHash: keccak256(code), factory: lower(config.factory), factoryCodeHash: config.factoryCodeHash,
      evaluator: lower(binding.target), executor: lower(binding.executor), projectKey: binding.projectKey, chainId, feedId: config.feedId, schemaHash: config.schemaHash };
  }
  async function grant(signal, id, blockNumber) {
    await correct();
    const value = safe(await read(signal.address, signalAbi, 'grant', [id], blockNumber));
    requireThat(value?.terms && (!zero(value.terms.publisher) || value.revoked), 'signal_grant_not_found');
    return { id, ...value };
  }
  return {
    state, verifyStore: store,
    async validateAdmission(config,factoryBuild) {
      await factory(config);
      const {validateSignalFactory}=await import('./signal-evidence.mjs');
      validateSignalFactory({factoryBuild,factoryBuildHash:config.factoryArtifactHash,executor:config.executor,
        factoryCode:await client.getCode({address:config.factory})});
    },
    async validateStoreBuild(config,signal,build,factoryBuild,blockNumber) {
      const {validateSignalRuntime}=await import('./signal-evidence.mjs');
      const [storeCode,factoryCode]=await Promise.all([signal.address,config.factory].map(address=>client.getCode({address,blockNumber:BigInt(blockNumber)})));
      validateSignalRuntime({build,buildHash:config.storeArtifactHash,factoryBuild,factoryBuildHash:config.factoryArtifactHash,
        executor:config.executor,storeCode,factoryCode});
    },
    async grant(signal,id) {
      const block=await client.getBlock({blockTag:'finalized'});
      const value=await grant(signal,id,block.number);
      requireThat((await client.getBlock({blockNumber:block.number})).hash===block.hash,'evidence_block_changed');
      return {...value,finalized:true,blockNumber:String(block.number),blockHash:block.hash};
    },
    async assertTrackedStore(config,binding,signal) {
      await factory(config);
      const existing=await read(config.factory,factoryAbi,'stores',[binding.projectKey]);
      requireThat(zero(existing) ? !signal : signal?.state==='verified' && lower(existing)===lower(signal.address),
        'signal_review_context_changed');
    },
    async latest(signal) {
      await correct();
      const block = await client.getBlock({ blockTag: 'finalized' });
      requireThat(keccak256(await client.getCode({ address: signal.address, blockNumber: block.number })) === signal.codeHash, 'signal_store_mismatch');
      const [record, project, pendingOwner, version] = await Promise.all([
        read(signal.address, signalAbi, 'latest', [], block.number).then(safe),
        read(signal.executor, executorAbi, 'projects', [signal.projectKey], block.number),
        read(signal.executor, executorAbi, 'pendingProjectOwners', [signal.projectKey], block.number),
        read(signal.evaluator, targetAbi, 'version', [], block.number)
      ]);
      const recordGrant = Number(record.sequence) > 0 ? await grant(signal, record.grantId, block.number) : null;
      const authorizationActive = Boolean(project[7] && zero(pendingOwner) &&
        lower(project[1]) === lower(signal.evaluator) && recordGrant && !recordGrant.revoked &&
        Number(recordGrant.terms.authorityGeneration) === Number(project[6]));
      requireThat((await client.getBlock({ blockNumber: block.number })).hash === block.hash, 'evidence_block_changed');
      return { record, authorizationActive, currentVersion: Number(version),
        blockNumber: block.number.toString(), blockHash: block.hash, blockTimestamp: Number(block.timestamp), finalized: true };
    },
    async prepareStore(config, binding) {
      await factory(config); const s = await state(binding); await eoa(s.owner);
      const existing=await read(config.factory,factoryAbi,'stores',[binding.projectKey]);
      if(!zero(existing)) {
        const block=await client.getBlock({blockTag:'finalized'});
        requireThat(lower(await read(config.factory,factoryAbi,'stores',[binding.projectKey],block.number))===lower(existing), 'signal_store_not_finalized');
        const signal=await store(config,binding,existing,block.number);
        requireThat((await client.getBlock({blockNumber:block.number})).hash===block.hash,'evidence_block_changed');
        return {recovered:true,signal,blockNumber:String(block.number),blockHash:block.hash,finalized:true};
      }
      return { transaction: intent(chainId, s.owner, config.factory, encodeFunctionData({ abi: factoryAbi, functionName: 'create',
        args: [binding.projectKey, config.feedId, config.schemaHash] })) };
    },
    async prepareGrant(signal, binding, terms) {
      const s = await state(binding); await Promise.all([eoa(s.owner), eoa(terms.publisher)]);
      requireThat(!await read(signal.address, signalAbi, 'grantNonces', [s.owner, BigInt(terms.nonce)]), 'signal_nonce_used');
      const message = { projectId: binding.projectKey, feedId: signal.feedId, schemaHash: signal.schemaHash,
        ...terms, authorityGeneration: s.authorityGeneration };
      const typedData = { domain: { name: 'Claus Signal', version: '1', chainId, verifyingContract: signal.address },
        types: grantTypes, primaryType: 'PublisherGrant', message };
      return { typedData, grantId: hashTypedData(typedData), owner: s.owner };
    },
    async registerGrant(signal, binding, prepared, signature) {
      const s = await state(binding);
      requireThat(s.owner === prepared.owner && s.authorityGeneration === prepared.typedData.message.authorityGeneration, 'signal_grant_stale');
      requireThat(await verifyTypedData({ address: s.owner, ...prepared.typedData, signature }), 'invalid_signature');
      const { projectId, feedId, schemaHash, ...terms } = prepared.typedData.message;
      return { transaction: intent(chainId, terms.publisher, signal.address, encodeFunctionData({ abi: signalAbi,
        functionName: 'registerGrant', args: [terms, signature] })) };
    },
    async prepareRecord(signal, binding, input) {
      const s = await state(binding), g = await grant(signal, input.grantId);
      const head = await client.getBlock({ blockTag: 'latest' });
      requireThat(!g.revoked && Number(g.terms.authorityGeneration) === s.authorityGeneration &&
        Number(g.terms.expiresAt) > Number(head.timestamp), 'signal_grant_inactive');
      requireThat(BigInt(g.used) < BigInt(g.terms.maximumWrites), 'signal_grant_exhausted');
      requireThat(s.version === input.expectedVersion, 'signal_stale_version');
      requireThat(input.validUntil > Number(head.timestamp) && input.observedAt <= Number(head.timestamp) &&
        input.validUntil <= Number(g.terms.expiresAt) && input.validUntil <= input.observedAt+86400, 'signal_data_expired');
      requireThat(Number(g.used)===0 || Number(head.timestamp)>=Number(g.lastWrite)+Number(g.terms.minimumInterval), 'signal_interval_pending');
      const current=await read(signal.address,signalAbi,'latest');
      requireThat(BigInt(input.sequence)===current.sequence+1n && BigInt(input.observedAt)>=current.observedAt,'signal_stale_sequence');
      const transaction = intent(chainId, g.terms.publisher, signal.address, encodeFunctionData({ abi: signalAbi, functionName: 'publish',
        args: [input.grantId, input.sequence, input.expectedVersion, input.observedAt, input.validUntil, input.sourceHash, input.data] }));
      // The exact sender/call is simulated; limits, sequence and interval are
      // rechecked by the immutable store when the signed transaction executes.
      await client.call({ account: transaction.from, to: transaction.to, data: transaction.data, gas: 700000n });
      return { transaction, publisher: transaction.from };
    },
    async prepareRevoke(signal, binding, grantId) {
      const s = await state(binding, false);
      return { transaction: intent(chainId, s.owner, signal.address, encodeFunctionData({ abi: signalAbi, functionName: 'revokeGrant', args: [grantId] })) };
    },
    async observe(action, hash) {
      await correct();
      let tx, receipt;
      try { tx = await client.getTransaction({ hash }); receipt = await client.getTransactionReceipt({ hash }); }
      catch (error) { if (['TransactionNotFoundError','TransactionReceiptNotFoundError'].includes(error.name)) return { state: 'pending' }; throw error; }
      const expected = action.transaction;
      requireThat(lower(tx.from) === expected.from && lower(tx.to) === expected.to && lower(tx.input) === lower(expected.data) &&
        tx.value === 0n && Number(tx.chainId) === chainId && lower(receipt.from) === expected.from && lower(receipt.to) === expected.to,
      'signal_transaction_mismatch');
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      requireThat(block.hash === receipt.blockHash, 'signal_transaction_reorganized');
      const final = await client.getBlock({ blockTag: 'finalized' });
      if (receipt.blockNumber > final.number) return { state: 'pending' };
      const evidence = { transactionHash: hash, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, finalized: true };
      if (receipt.status !== 'success') return { state: 'failed', error: 'signal_transaction_reverted', ...evidence };
      if (action.kind === 'store') {
        const address = await read(action.config.factory, factoryAbi, 'stores', [action.binding.projectKey], receipt.blockNumber);
        return { state: 'confirmed', signal: await store(action.config, action.binding, address, receipt.blockNumber), ...evidence };
      }
      return { state: 'confirmed', ...evidence };
    }
  };
}

export function createSignalRouter({ sepolia, mainnet }) {
  const selected = chainId => { const value = chainId === 1 ? mainnet : chainId === 11155111 ? sepolia : null;
    requireThat(value, 'signal_chain_unavailable'); return value; };
  return {
    validateAdmission: (c,b) => selected(c.chainId).validateAdmission(c,b),
    validateStoreBuild: (c,s,b,f,n) => selected(c.chainId).validateStoreBuild(c,s,b,f,n),
    assertTrackedStore: (c,b,s) => selected(b.chainId).assertTrackedStore(c,b,s),
    prepareStore: (c,b) => selected(b.chainId).prepareStore(c,b),
    prepareGrant: (s,b,t) => selected(b.chainId).prepareGrant(s,b,t),
    registerGrant: (s,b,p,sig) => selected(b.chainId).registerGrant(s,b,p,sig),
    prepareRecord: (s,b,i) => selected(b.chainId).prepareRecord(s,b,i),
    prepareRevoke: (s,b,g) => selected(b.chainId).prepareRevoke(s,b,g),
    observe: (a,h) => selected(a.binding.chainId).observe(a,h),
    grant: (s,g) => selected(s.chainId).grant(s,g),
    latest: s => selected(s.chainId).latest(s)
  };
}
