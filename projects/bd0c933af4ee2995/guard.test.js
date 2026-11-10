import { decide } from './guard.js';
const cases = [
  ['mostly self-funded in sample', false],
  ['unknown: no sampled inflows', false],
  ['mostly outside or unlabelled senders in sample (not proof of independent customers)', true],
];
let fail = 0;
for (const [v, want] of cases) {
  const got = decide({ verdict: v }).allow;
  console.log(got === want ? 'PASS' : 'FAIL', JSON.stringify(v), '->', got);
  if (got !== want) fail++;
}
if (decide({ verdict: 'unknown: x' }, { onUnknown: 'allow' }).allow !== true) { console.log('FAIL onUnknown allow'); fail++; } else console.log('PASS onUnknown allow');
process.exit(fail ? 1 : 0);
