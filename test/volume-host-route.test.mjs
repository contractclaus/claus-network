import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {requestUrl} from '../runtime/request-url.mjs';
test('volume funding is routed from the production host to its authenticated handler',()=>{const config=JSON.parse(fs.readFileSync(new URL('../vercel.json',import.meta.url)));const rule=config.rewrites.find(x=>x.source==='/internal/infrastructure/volume-funding');assert(rule);assert.equal(requestUrl(rule.destination,'https://network.example').pathname,rule.source);assert.equal(requestUrl(rule.source,'https://network.example').pathname,rule.source);});
test('the new rewrite does not admit arbitrary internal gateway routes',()=>{assert.equal(requestUrl('/api/gateway?__claus_route=/internal/unknown','https://network.example').pathname,'/api/gateway');assert.equal(requestUrl('/v1/projects?__claus_route=/internal/infrastructure/volume-funding','https://network.example').pathname,'/v1/projects');});
