import {managedDatabase,managedSchemaReady} from './database-schema.js';
import {randomUUID} from 'node:crypto';
import {sql} from './store.js';

// This journal belongs only to the native Jobs wallet. It never shares a nonce
// lock or allowance with the token owner, arbitration signer or model payments.
export function createWorkWalletStore(database:any=sql){
  let initialized:Promise<void>|undefined;
  function initialize(){if(managedDatabase())return managedSchemaReady();return initialized??=(async()=>{
    const db=database();
    await db`CREATE TABLE IF NOT EXISTS claus_work_wallet(address text PRIMARY KEY,active_id text,fence text,lease_until timestamptz,principal_spent numeric(78) NOT NULL DEFAULT 0,principal_reserved numeric(78) NOT NULL DEFAULT 0,gas_spent numeric(78) NOT NULL DEFAULT 0,gas_reserved numeric(78) NOT NULL DEFAULT 0)`;
    await db`ALTER TABLE claus_work_wallet ADD COLUMN IF NOT EXISTS claus_spent numeric(78) NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS claus_reserved numeric(78) NOT NULL DEFAULT 0`;
    await db`CREATE TABLE IF NOT EXISTS claus_work_wallet_actions(id text PRIMARY KEY,address text NOT NULL,input_hash text NOT NULL,input jsonb NOT NULL,status text NOT NULL DEFAULT 'preparing',transaction jsonb,sealed text,hash text,receipt jsonb,error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`;
    await db`CREATE UNIQUE INDEX IF NOT EXISTS claus_work_wallet_nonce ON claus_work_wallet_actions(address,((transaction->>'nonce')::bigint)) WHERE transaction IS NOT NULL`;
  })().catch(e=>{initialized=undefined;throw e;});}
  async function get(id:string){await initialize();return (await database()`SELECT * FROM claus_work_wallet_actions WHERE id=${id}`)[0];}
  async function anchor(address:string){await initialize();return (await database()`SELECT receipt FROM claus_work_wallet_actions WHERE address=${address} AND receipt IS NOT NULL ORDER BY (receipt->>'blockNumber')::numeric DESC LIMIT 1`)[0]?.receipt;}
  async function state(address:string){await initialize();const db=database();await db`INSERT INTO claus_work_wallet(address) VALUES(${address}) ON CONFLICT DO NOTHING`;
    return {account:(await db`SELECT * FROM claus_work_wallet WHERE address=${address}`)[0],actions:await db`SELECT id,status,hash,input,error,receipt,created_at,updated_at FROM claus_work_wallet_actions WHERE address=${address} ORDER BY created_at DESC LIMIT 12`};}
  async function acquire(address:string,id:string,inputHash:string,input:any){
    await state(address);const db=database();
    await db`INSERT INTO claus_work_wallet_actions(id,address,input_hash,input) VALUES(${id},${address},${inputHash},${JSON.stringify(input)}::jsonb) ON CONFLICT DO NOTHING`;
    const existing=await get(id);if(existing.input_hash!==inputHash||existing.address!==address)throw Error('work_wallet_id_conflict');
    if(['confirmed','reverted'].includes(existing.status))return {row:existing,fence:null};
    const fence=randomUUID();const changed=await db`UPDATE claus_work_wallet SET active_id=${id},fence=${fence},lease_until=now()+interval '90 seconds' WHERE address=${address} AND (active_id IS NULL OR active_id=${id} AND (lease_until IS NULL OR lease_until<now())) RETURNING address`;
    if(changed.length!==1)throw Error('work_wallet_busy_read_status');
    return {row:await get(id),fence};
  }
  async function saveSigned(address:string,id:string,fence:string,tx:any,sealed:string,hash:string,limits:any){
    const gas=(BigInt(tx.gas)*BigInt(tx.maxFeePerGas)).toString();const rows=await database()`WITH budget AS (
      UPDATE claus_work_wallet SET claus_reserved=claus_reserved+${tx.tokenValue??'0'}::numeric,principal_reserved=principal_reserved+${tx.value}::numeric,gas_reserved=gas_reserved+${gas}::numeric
      WHERE address=${address} AND active_id=${id} AND fence=${fence} AND lease_until>now()
      AND principal_spent+principal_reserved+${tx.value}::numeric<=${limits.principal}::numeric
      AND claus_spent+claus_reserved+${tx.tokenValue??'0'}::numeric<=${limits.tokenPrincipal??'0'}::numeric
      AND gas_spent+gas_reserved+${gas}::numeric<=${limits.gas}::numeric
      AND EXISTS(SELECT 1 FROM claus_work_wallet_actions WHERE id=${id} AND transaction IS NULL)
      RETURNING address)
      UPDATE claus_work_wallet_actions SET transaction=${JSON.stringify(tx)}::jsonb,sealed=${sealed},hash=${hash},status='signed',error=NULL,updated_at=now()
      WHERE id=${id} AND transaction IS NULL AND EXISTS(SELECT 1 FROM budget) RETURNING id`;
    if(rows.length!==1)throw Error('work_wallet_budget_or_fence_changed');
    return get(id);
  }
  async function finish(address:string,id:string,fence:string,receipt:any){
    const row=await get(id),tx=row.transaction;
    if(!tx)throw Error('work_wallet_not_signed');
    const reservedGas=(BigInt(tx.gas)*BigInt(tx.maxFeePerGas)).toString(),actualGas=(BigInt(receipt.gasUsed)*BigInt(receipt.effectiveGasPrice)).toString();
    if(BigInt(actualGas)>BigInt(reservedGas))throw Error('work_wallet_receipt_mismatch');
    const rows=await database()`WITH settled AS (
      UPDATE claus_work_wallet SET claus_reserved=claus_reserved-${tx.tokenValue??'0'}::numeric,claus_spent=claus_spent+${receipt.status==='success'?(tx.tokenValue??'0'):'0'}::numeric,principal_reserved=principal_reserved-${tx.value}::numeric,gas_reserved=gas_reserved-${reservedGas}::numeric,
      principal_spent=principal_spent+${receipt.status==='success'?tx.value:'0'}::numeric,gas_spent=gas_spent+${actualGas}::numeric,active_id=NULL,fence=NULL,lease_until=NULL
      WHERE address=${address} AND active_id=${id} AND fence=${fence} AND EXISTS(SELECT 1 FROM claus_work_wallet_actions WHERE id=${id} AND status='signed') RETURNING address)
      UPDATE claus_work_wallet_actions SET status=${receipt.status==='success'?'confirmed':'reverted'},receipt=${JSON.stringify(receipt)}::jsonb,error=NULL,updated_at=now()
      WHERE id=${id} AND EXISTS(SELECT 1 FROM settled) RETURNING id`;
    if(rows.length!==1)throw Error('work_wallet_fence_changed');return get(id);
  }
  async function release(address:string,id:string,fence:string,error?:string){
    const db=database();
    // Unknown signed transactions retain the wallet lock and both reservations.
    await db`WITH owned AS (UPDATE claus_work_wallet SET active_id=CASE WHEN EXISTS(SELECT 1 FROM claus_work_wallet_actions WHERE id=${id} AND transaction IS NOT NULL) THEN active_id ELSE NULL END,fence=NULL,lease_until=NULL WHERE address=${address} AND active_id=${id} AND fence=${fence} RETURNING address)
      UPDATE claus_work_wallet_actions SET error=${error??null},updated_at=now() WHERE id=${id} AND EXISTS(SELECT 1 FROM owned)`;
  }
  return {initialize,get,anchor,state,acquire,saveSigned,finish,release};
}
