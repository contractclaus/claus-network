import {fundingHash} from './policy.mjs';
export const fundingWalletSchema=`
CREATE TABLE IF NOT EXISTS claus_wallet_actions(id text PRIMARY KEY,input_hash text NOT NULL,kind text NOT NULL,chain_id integer,status text NOT NULL,input jsonb NOT NULL,result jsonb,signed jsonb,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS claus_wallet_chains(chain_id integer PRIMARY KEY,active_id text);
INSERT INTO claus_wallet_chains(chain_id) VALUES(1),(8453) ON CONFLICT DO NOTHING;
CREATE UNIQUE INDEX IF NOT EXISTS claus_wallet_nonce ON claus_wallet_actions(chain_id,((signed->>'nonce')::bigint)) WHERE signed IS NOT NULL;
`;
export function fundingWalletRepository(pool){
 const one=async(sql,args)=>(await pool.query(sql,args)).rows[0]??null;
 return {
  get:id=>one('SELECT * FROM claus_wallet_actions WHERE id=$1',[id]),
  async reserve(id,kind,input){
   const row=await one("INSERT INTO claus_wallet_actions(id,input_hash,kind,chain_id,status,input) VALUES($1,$2,$3,$4,'preparing',$5) ON CONFLICT DO NOTHING RETURNING *",[id,fundingHash(input),kind,input.chainId,input]);
   if(row)return {created:true,row};
   const old=await this.get(id);if(old.input_hash!==fundingHash(input)||old.kind!==kind)throw Error('funding_wallet_id_conflict');return {created:false,row:old};
  },
  async save(id,status,result,signed){await pool.query('UPDATE claus_wallet_actions SET status=$2,result=$3,signed=COALESCE($4::jsonb,signed),updated_at=now() WHERE id=$1',[id,status,result,signed??null]);},
  async claimBroadcast(id,at){return !!await one("UPDATE claus_wallet_actions SET status='submitted',result=result||jsonb_build_object('broadcastAttemptedAt',$2::bigint),updated_at=now() WHERE id=$1 AND status='signed' AND signed IS NOT NULL RETURNING id",[id,at]);},
  async claim(id,chain){return !!await one("WITH locked AS(UPDATE claus_wallet_chains SET active_id=$1 WHERE chain_id=$2 AND active_id IS NULL AND EXISTS(SELECT 1 FROM claus_wallet_actions WHERE id=$1 AND status='prepared') RETURNING chain_id) UPDATE claus_wallet_actions SET status='signing',updated_at=now() WHERE id=$1 AND status='prepared' AND EXISTS(SELECT 1 FROM locked) RETURNING id",[id,chain]);},
  async lastNonce(chain){return (await one("SELECT max((signed->>'nonce')::bigint) n FROM claus_wallet_actions WHERE chain_id=$1 AND signed IS NOT NULL",[chain])).n;},
  async unlock(id,chain){await pool.query('UPDATE claus_wallet_chains SET active_id=NULL WHERE chain_id=$2 AND active_id=$1',[id,chain]);},
  async exposure(cycle,chain){return (await one("SELECT COALESCE(sum((result->>'maximumFeeWei')::numeric),0)::text n FROM claus_wallet_actions WHERE chain_id=$1 AND result->>'fundingCycle'=$2 AND (signed IS NOT NULL OR status='signing')",[chain,cycle])).n;}
 };
}
