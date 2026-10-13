import { parentPort, workerData } from 'node:worker_threads';

// No caller-provided callbacks, scripts, package install, tests or filesystem
// imports. Solidity is compiled as data; constructors are never executed here.
try {
  if (!['solidity-static-compile-v1', 'solidity-0.8.26-static-v1', 'solidity-managed-compile-v1'].includes(workerData.compilerProfile)) throw Error('unsupported_compiler_profile');
  const solc = workerData.compilerProfile === 'solidity-0.8.26-static-v1'
    ? (await import('solc-0.8.26')).default : (await import('solc')).default;
  const output = solc.compile(JSON.stringify(workerData.input), { import: () => ({ error: 'Only snapshot sources are available' }) });
  if (Buffer.byteLength(output) > 4000000) throw Error('compiler_output_limit');
  parentPort.postMessage({ version: solc.version(), output });
} catch { parentPort.postMessage({ error: 'compilation_failed' }); }
