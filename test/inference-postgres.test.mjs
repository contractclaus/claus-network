import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { openPostgresStore } from '../src/postgres/index.mjs';
import { createBilling, balance } from '../src/billing/index.mjs';
import { createJobs } from '../src/jobs/index.mjs';
import { createArtifactStore } from '../src/artifact-store/index.mjs';
import { createInference } from '../src/inference/index.mjs';
import { digest } from '../src/shared/index.mjs';

const credentials = process.env.NETWORK_TEST_CREDENTIAL_FILE;
neonConfig.webSocketConstructor = ws;
test('PostgreSQL inference: parallel allowance admission and restart settle one original request',
  { skip: !credentials, timeout: 180000 }, async t => {
    const settings = JSON.parse(await readFile(credentials, 'utf8'));
    const schema = 'inference_acceptance_' + randomBytes(8).toString('hex');
    const makePool = () => new Pool({ connectionString: settings.migrationUrl, connectionTimeoutMillis: 10000, max: 3 });
    const pool = makePool(), store = await openPostgresStore({ pool, schema, migrate: true });
    let other;
    t.after(async () => { await other?.close(); await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await store.close(); });
    other = await openPostgresStore({ pool: makePool(), schema });
    let time = 1800000000000, complete = false;
    const calls = [], proof = digest({ fixture: 'postgres-not-real-provider' });
    const profile = { id: 'text', version: 'v1', enabled: true, providerId: 'test-provider', accountId: 'test-org',
      model: 'test-model', providers: ['test-upstream'], asset: 'test-only-credit', fundingAccount: 'test-funded',
      permissionHash: proof, dataPolicyHash: proof, expiresAt: time + 86400000,
      maximumPerRequest: '200', maxInputBytes: 8000, maxOutputTokens: 1024 };
    await store.transaction(async tx => {
      await tx.write('inference-profiles', profile.id, profile, 0);
      await tx.write('inference-allowances', digest({ projectId: 'project', profileId: profile.id }),
        { enabled: true, expiresAt: time + 86400000, limit: '200', reserved: '0', spent: '0' }, 0);
    });
    await createBilling({ store, authorize: () => true, now: () => time }).recordFunding({
      actor: 'fixture', account: profile.fundingAccount, asset: profile.asset, amount: '1000', receiptId: 'test-funding' });
    const provider = {
      async quote(p) { return { id: digest({ quote: p.requestHash }), providerId: profile.providerId, accountId: profile.accountId,
        asset: profile.asset, requestHash: p.requestHash, profileHash: digest(profile), maximum: '200', expiresAt: time + 300000, proofHash: proof }; },
      async dispatch(p) { calls.push({ mode: 'dispatch', id: p.effectKey }); throw Error('test timeout after send'); },
      async reconcile(p) {
        calls.push({ mode: 'reconcile', id: p.effectKey }); if (!complete) return null;
        return { work: 'completed', output: { model: profile.model, text: 'Explicit test fixture' }, providerRequestId: 'one-provider-request',
          receipt: { effectKey: p.effectKey, requestHash: p.requestHash, profileHash: p.quote.profileHash, quoteId: p.quote.id,
            providerId: profile.providerId, accountId: profile.accountId, providerRequestId: 'one-provider-request', asset: profile.asset,
            actual: '125', final: true, proofHash: proof } };
      }
    };
    const core = db => {
      const identity = { authorize: async () => {} };
      return createInference({ store: db, identity, jobs: createJobs({ store: db, identity, now: () => time }),
        artifacts: createArtifactStore({ store: db }), provider, enabled: () => true, now: () => time,
        verifyQuote: async q => q.proofHash === proof, verifyReceipt: async r => r.proofHash === proof });
    };
    const a = core(store); let b = core(other);
    const body = key => ({ profileId: profile.id, profileHash: digest(profile), model: profile.model, input: 'test input', maxOutputTokens: 128, idempotencyKey: key });
    const admitted = await Promise.allSettled([a.submit('test-actor', 'project', body('a')), b.submit('test-actor', 'project', body('b'))]);
    assert.equal(admitted.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(admitted.find(x => x.status === 'rejected').reason.code, 'inference_allowance_exhausted');
    const winner = admitted.find(x => x.status === 'fulfilled').value;
    assert.equal((await balance(store, profile.fundingAccount, profile.asset)).reserved, '200');
    await Promise.all([a.run(), b.run()]); assert.equal(calls.length, 1);
    await other.close(); other = await openPostgresStore({ pool: makePool(), schema }); b = core(other);
    time += 60001; complete = true; await b.run();
    assert.deepEqual(calls.map(c => c.mode), ['dispatch', 'reconcile']); assert.equal(calls[0].id, calls[1].id);
    assert.equal((await b.get('test-actor', 'project', winner.id)).cost.actual, '125');
    assert.deepEqual(await balance(store, profile.fundingAccount, profile.asset), {
      account: profile.fundingAccount, asset: profile.asset, available: '875', reserved: '0', spent: '125' });
    t.diagnostic('Only a disposable schema was changed; no model, provider, wallet or production request was used.');
  });
