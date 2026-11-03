import assert from 'assert';
import * as cw from './src/codewatch.js';
const s = {};
assert.equal(cw.observe(s, 'a.near', 'H1').change, 'first_seen');
assert.equal(cw.observe(s, 'a.near', 'H1').change, 'unchanged');
const c = cw.observe(s, 'a.near', 'H2');
assert.equal(c.change, 'changed'); assert.equal(c.previous, 'H1');
assert.equal(cw.observe(s, 'b.near', cw.EMPTY).hasCode, false);
console.log('codewatch tests ok');
