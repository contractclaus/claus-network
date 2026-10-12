import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {Pool,neonConfig} from '@neondatabase/serverless';
import ws from 'ws';
import {openStore} from '../src/storage/index.mjs';
import {openPostgresStore} from '../src/postgres/index.mjs';

async function boundedJournal(store) {
  const value={intent:{data:'0x'+'ab'.repeat(20000)},sealedRaw:'x'.repeat(54000)};
  await store.transaction(tx=>tx.write('chain-transactions','deployment',value,0));
  assert.deepEqual((await store.read('chain-transactions','deployment')).value,value);
  await assert.rejects(store.transaction(tx=>tx.write('snapshots','oversized',value,0)),{code:'document_too_large'});
  await assert.rejects(store.transaction(tx=>tx.write('chain-transactions','oversized',{data:'x'.repeat(393216)},0)),{code:'document_too_large'});
  assert.equal(await store.read('chain-transactions','oversized'),null);
  await store.transaction(tx=>tx.write('chain-transactions','deployment',{...value,state:'confirmed'},1));
  assert.equal((await store.read('chain-transactions','deployment')).revision,2);
}

test('SQLite persists bounded signed deployments without increasing public document sizes',async t=>{
  const store=openStore(':memory:');t.after(()=>store.close());await boundedJournal(store);
});

test('PostgreSQL persists the same signed deployment and size boundaries', {skip:!process.env.NETWORK_TEST_CREDENTIAL_FILE}, async t=>{
  neonConfig.webSocketConstructor=ws;
  const settings=JSON.parse(await readFile(process.env.NETWORK_TEST_CREDENTIAL_FILE));
  const pool=new Pool({connectionString:settings.migrationUrl,max:1});
  const schema='journal_'+randomBytes(8).toString('hex');
  const store=await openPostgresStore({pool,schema,migrate:true});
  t.after(async()=>{await pool.query(`DROP SCHEMA "${schema}" CASCADE`);await store.close();});
  await boundedJournal(store);
});
