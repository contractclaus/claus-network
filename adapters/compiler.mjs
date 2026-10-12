import { Worker } from 'node:worker_threads';
import { keccak256 } from 'viem';
import { canonical, digest, requireThat } from '../src/shared/index.mjs';

export const COMPILER_PROFILE = Object.freeze({ compiler: '0.8.27+commit.40a35a09.Emscripten.clang',
  evmVersion: 'cancun', optimizerRuns: 200, viaIR: true, profile: 'solidity-static-compile-v1' });
export const MARKET_COMPILER_PROFILE = Object.freeze({ ...COMPILER_PROFILE,
  compiler: '0.8.26+commit.8a97fa7a.Emscripten.clang', profile: 'solidity-0.8.26-static-v1' });

export async function compileSnapshot({ files, entry, contract, compilerProfile = COMPILER_PROFILE.profile, sourceRoot }) {
  requireThat([COMPILER_PROFILE.profile, MARKET_COMPILER_PROFILE.profile].includes(compilerProfile), 'unsupported_compiler_profile');
  const profile = compilerProfile === COMPILER_PROFILE.profile ? COMPILER_PROFILE : MARKET_COMPILER_PROFILE;
  requireThat(sourceRoot === undefined || (typeof sourceRoot === 'string' && sourceRoot.length <= 160 &&
    /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(sourceRoot) &&
    sourceRoot.split('/').every(part => part !== '.' && part !== '..')), 'invalid_source_root');
  const prefix = sourceRoot === undefined ? '' : sourceRoot + '/';
  requireThat(typeof entry === 'string' && entry.startsWith(prefix), 'entry_outside_source_root');
  requireThat(Array.isArray(files) && files.length > 0 && files.length <= 64, 'invalid_files');
  requireThat(Buffer.byteLength(canonical(files)) <= 320000, 'snapshot_too_large');
  requireThat(typeof contract === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(contract), 'invalid_contract');
  const sources = Object.fromEntries(files.filter(f => f.path.endsWith('.sol')).map(f => [f.path, { content: f.content }]));
  requireThat(Object.hasOwn(sources, entry), 'entry_missing');
  const input = { language: 'Solidity', sources, settings: { optimizer: { enabled: true, runs: 200 },
    viaIR: true, evmVersion: 'cancun', metadata: { bytecodeHash: 'ipfs' },
    remappings: ['@openzeppelin/contracts/=' + prefix + 'lib/openzeppelin-contracts/contracts/',
      ...(profile === MARKET_COMPILER_PROFILE ? ['@uniswap/v4-core/=' + prefix + 'lib/v4-core/', 'solmate/=' + prefix + 'lib/v4-core/lib/solmate/'] : [])],
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'metadata', 'storageLayout'] } } } };
  const result = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./compiler-worker.mjs', import.meta.url), { workerData: { input, compilerProfile },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 8 },
      env: {}, execArgv: [] });
    const timer = setTimeout(() => { worker.terminate(); reject(Object.assign(Error('compiler_timeout'), { code: 'compiler_timeout' })); }, 45000);
    worker.once('message', value => { clearTimeout(timer); worker.terminate(); resolve(value); });
    worker.once('error', () => { clearTimeout(timer); reject(Object.assign(Error('compiler_failed'), { code: 'compiler_failed' })); });
    worker.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(Object.assign(Error('compiler_failed'), { code: 'compiler_failed' })); });
  });
  requireThat(!result.error && result.version === profile.compiler, 'compiler_profile_mismatch');
  const output = JSON.parse(result.output);
  const errors = (output.errors ?? []).filter(x => x.severity === 'error');
  if (errors.length) return { status: 'rejected', profile,
    errors: errors.slice(0, 12).map(x => ({ code: x.errorCode ?? 'compiler', message: x.message.slice(0, 500) })) };
  const artifact = output.contracts?.[entry]?.[contract];
  requireThat(artifact?.evm.bytecode.object && artifact?.evm.deployedBytecode.object, 'deployable_contract_missing');
  requireThat(Object.keys(artifact.evm.bytecode.linkReferences).length === 0, 'external_libraries_not_supported');
  requireThat(artifact.evm.deployedBytecode.object.length / 2 <= 24576, 'runtime_too_large');
  return { status: 'compiled', profile, inputHash: digest(input), entry, contract,
    creationBytecode: '0x' + artifact.evm.bytecode.object,
    runtimeTemplate: '0x' + artifact.evm.deployedBytecode.object,
    runtimeTemplateHash: keccak256('0x' + artifact.evm.deployedBytecode.object),
    immutableReferences: artifact.evm.deployedBytecode.immutableReferences,
    abi: artifact.abi, storageLayout: artifact.storageLayout, metadata: artifact.metadata,
    evidenceLevel: 'compiled_only', standardInput: input };
}
