import { keccak256, stringToHex, toHex } from 'viem';
import { digest, requireThat } from '../src/shared/index.mjs';
import { captureVaultConsumer } from './vault-evidence.mjs';

export const PROXY_SLOTS = Object.freeze([
  toHex(BigInt(keccak256(stringToHex('eip1967.proxy.implementation'))) - 1n, { size: 32 }),
  toHex(BigInt(keccak256(stringToHex('eip1967.proxy.beacon'))) - 1n, { size: 32 }),
  keccak256(stringToHex('PROXIABLE'))
]);
const ZERO = '0x' + '0'.repeat(64);
const address = x => typeof x === 'string' && /^0x[0-9a-f]{40}$/i.test(x) && !/^0x0{40}$/i.test(x);
const bytecode = x => typeof x === 'string' && /^0x(?:[0-9a-f]{2}){1,24576}$/i.test(x);

// Conservative linear disassembly, including metadata. PUSH data is not an
// instruction. A hit rejects this initial direct-contract profile; it is not
// a general EVM reachability proof or a certification of external data.
export function inspectCode(code) {
  requireThat(bytecode(code), 'dependency_code_missing');
  requireThat(!code.toLowerCase().startsWith('0xef0100'), 'dependency_delegation_unsupported');
  const bytes = Buffer.from(code.slice(2), 'hex'), forbidden = [];
  for (let offset = 0; offset < bytes.length; offset++) {
    const opcode = bytes[offset];
    if ([0xf2, 0xf4, 0xff].includes(opcode)) forbidden.push({ offset, opcode });
    if (opcode >= 0x60 && opcode <= 0x7f) offset += opcode - 0x5f;
  }
  requireThat(forbidden.length === 0, 'dependency_indirection_unsupported');
  return { method: 'linear-opcodes-v1', callcode: false, delegatecall: false, selfdestruct: false };
}

export function validateBuildEvidence(build, source, implementation) {
  requireThat(digest(build) === source.buildHash && build.status === 'compiled' &&
    build.profile?.profile === 'solidity-static-compile-v1' && build.entry === source.entry &&
    digest(build.standardInput) === build.inputHash &&
    digest(build.standardInput.sources) === digest(Object.fromEntries(source.files.filter(f => f.path.endsWith('.sol'))
      .map(f => [f.path, { content: f.content }]))) &&
    Object.keys(build.immutableReferences ?? {}).length === 0 &&
    build.runtimeTemplate === implementation.code && keccak256(build.runtimeTemplate) === implementation.codeHash &&
    build.runtimeTemplateHash === implementation.codeHash, 'build_evidence_mismatch');
}

export function createChainEvidence({ client }) {
  const slots = async (at, blockNumber) => Promise.all(PROXY_SLOTS.map(async slot => ({ slot,
    value: (await client.getStorageAt({ address: at, slot, blockNumber })) ?? ZERO })));
  async function contract(at, blockNumber) {
    at = at.toLowerCase();
    const [code, storage] = await Promise.all([client.getCode({ address: at, blockNumber }), slots(at, blockNumber)]);
    const inspection = inspectCode(code);
    requireThat(storage.every(x => x.value === ZERO), 'dependency_proxy_unsupported');
    return { address: at, code, codeHash: keccak256(code), proxySlots: storage, inspection };
  }
  return {
    async capture({ module, dependencies = [], consumer }) {
      requireThat(await client.getChainId() === 11155111, 'wrong_chain');
      requireThat(Array.isArray(dependencies) && dependencies.length <= 8 && dependencies.every(x =>
        x && address(x.address) && typeof x.callData === 'string' && /^0x(?:[0-9a-f]{2}){0,4096}$/i.test(x.callData)) &&
        new Set(dependencies.map(x => x.address.toLowerCase())).size === dependencies.length, 'invalid_dependencies');
      const block = await client.getBlock({ blockTag: 'finalized' });
      const implementation = await contract(module.address, block.number);
      requireThat(implementation.codeHash === module.codeHash, 'module_code_changed');
      const captured = await Promise.all(dependencies.map(async dep => {
        const value = await contract(dep.address, block.number);
        const call = dep.callData === '0x' ? null : await client.call({ to: value.address, data: dep.callData,
          blockNumber: block.number, gas: 250000n });
        requireThat(!call || typeof call.data === 'string' && call.data.length <= 16386, 'dependency_call_invalid');
        return { ...value, call: call ? { data: dep.callData, result: call.data, gasLimit: 250000 } : null };
      }));
      const usage = consumer ? await captureVaultConsumer({ client, contract, consumer, blockNumber: block.number }) : null;
      requireThat((await client.getBlock({ blockNumber: block.number })).hash === block.hash, 'evidence_block_changed');
      return { version: 'claus-chain-evidence-v1', chainId: 11155111, blockNumber: block.number.toString(),
        blockHash: block.hash, blockTimestamp: Number(block.timestamp), blockTag: 'finalized',
        implementation, dependencies: captured, ...(usage ? { consumer: usage } : {}) };
    },
    async validate(snapshot, proposal) {
      requireThat(snapshot?.version === 'claus-chain-evidence-v1' && snapshot.chainId === proposal.chainId &&
        snapshot.implementation.address.toLowerCase() === proposal.implementation.toLowerCase() &&
        snapshot.implementation.codeHash === proposal.toCodeHash &&
        '0x' + digest(snapshot).slice(7) === proposal.dependencySnapshotHash, 'dependency_evidence_mismatch');
      requireThat((await client.getBlock({ blockNumber: BigInt(snapshot.blockNumber) })).hash === snapshot.blockHash,
        'evidence_block_changed');
      const head = await client.getBlock({ blockTag: 'latest' });
      for (const saved of [snapshot.implementation, ...snapshot.dependencies, ...(snapshot.consumer ? [snapshot.consumer.vault] : [])]) {
        const current = await contract(saved.address, head.number);
        requireThat(current.codeHash === saved.codeHash && digest(current.proxySlots) === digest(saved.proxySlots),
          'dependency_code_changed');
      }
      // Storage values and balanceOf results are intentionally live; only code
      // identity and absence of supported indirection are rechecked here.
    }
  };
}
