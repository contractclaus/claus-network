import { parentPort, workerData } from 'node:worker_threads';
import solc from 'solc';

// No caller-provided callbacks, scripts, package install, tests or filesystem
// imports. Solidity is compiled as data; constructors are never executed here.
try {
  const output = solc.compile(JSON.stringify(workerData), { import: () => ({ error: 'Only snapshot sources are available' }) });
  if (Buffer.byteLength(output) > 4000000) throw Error('compiler_output_limit');
  parentPort.postMessage({ version: solc.version(), output });
} catch { parentPort.postMessage({ error: 'compilation_failed' }); }
