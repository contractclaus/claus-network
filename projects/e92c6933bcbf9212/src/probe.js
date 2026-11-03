import { gatherFacts } from './near.js';
import { assess } from './check.js';
const id = process.argv[2] || 'wrap.near';
const facts = await gatherFacts(id, { interactions: {}, blocklist: {} }, 0.5);
console.log(JSON.stringify({ facts, verdict: assess(facts) }, null, 2));
