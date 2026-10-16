import {FUNDING as P,fundingHash,validateFundingApproval} from './policy.mjs';
import {validateProviderCredit} from './prepaid.mjs';
import {receivedUsdc} from './transactions.mjs';
const check=(v,message)=>{if(!v)throw Error(message);};
export const fundingSchema=`
CREATE TABLE IF NOT EXISTS claus_compute_funding_status(id boolean PRIMARY KEY CHECK(id),result jsonb NOT NULL,observed_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS claus_funding_cycles(
 id text PRIMARY KEY,policy_hash text NOT NULL,approval jsonb NOT NULL,
 claim_wei numeric(78) NOT NULL,context jsonb NOT NULL,state text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),grant_micro bigint NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS claus_funding_one_active ON claus_funding_cycles((true)) WHERE state='active';
CREATE TABLE IF NOT EXISTS claus_funding_steps(
 id text PRIMARY KEY,cycle_id text NOT NULL REFERENCES claus_funding_cycles(id),step text NOT NULL,
 transaction jsonb NOT NULL,context jsonb NOT NULL,state text NOT NULL DEFAULT 'reserved',
 receipt jsonb,UNIQUE(cycle_id,step));
CREATE TABLE IF NOT EXISTS claus_funding_credits(
 cycle_id text PRIMARY KEY REFERENCES claus_funding_cycles(id),transaction_hash text UNIQUE NOT NULL,
 amount bigint NOT NULL CHECK(amount>0),evidence jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS claus_funding_allocations(
 cycle_id text PRIMARY KEY REFERENCES claus_funding_cycles(id),allocation jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS claus_funding_provider_credit_unique ON claus_funding_credits
 ((evidence->'providerCredit'->>'address'),(evidence->'providerCredit'->>'id'))
 WHERE evidence->'providerCredit'->>'id' IS NOT NULL;
`;
// Installed only by the operator upon explicit activation. Never a runtime
// migration, and no unconditional "600 -> 1200" update belongs in setup.
export function fundingRepository(pool,{binding,now=Date.now}={}){
 const one=async(sql,params)=>(await pool.query(sql,params)).rows[0]??null;
 const cycle=r=>{if(r&&r.policy_hash!==fundingHash(P))throw Error('funding_original_policy_mismatch');return r?{id:r.id,claimWei:String(r.claim_wei),context:r.context,state:r.state}:null;};
 async function transaction(run){const c=await pool.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(6041040)');const v=await run(c);await c.query('COMMIT');return v;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 return {
  async active(){return cycle(await one("SELECT * FROM claus_funding_cycles WHERE state='active' ORDER BY created_at LIMIT 1"));},
  async unsettledSteps(approval){
   return (await pool.query("SELECT s.* FROM claus_funding_steps s JOIN claus_funding_cycles c ON c.id=s.cycle_id WHERE s.state='reserved' AND c.policy_hash=$1 AND c.approval=$2::jsonb ORDER BY c.created_at,s.id LIMIT 6",[fundingHash(P),JSON.stringify(approval)])).rows;
  },
  reserve:input=>transaction(async c=>{
   validateFundingApproval(input.approval,{binding,now:now()});
   check(input.policyHash===fundingHash(P)&&input.claimWei===P.claimPerCycleWei,'funding_policy_changed');
   const old=(await c.query("SELECT * FROM claus_funding_cycles WHERE state='active' FOR UPDATE")).rows[0];if(old)return cycle(old);
   check(!(await c.query("SELECT 1 FROM claus_funding_cycles WHERE state='failed' LIMIT 1")).rows.length,'funding_failed_original_requires_review');
   const stats=(await c.query('SELECT count(*)::int n,COALESCE(sum(claim_wei),0)::text claimed,max(created_at) latest FROM claus_funding_cycles')).rows[0];
   check(stats.n<P.maxCycles&&BigInt(stats.claimed)+BigInt(input.claimWei)<=BigInt(P.claimTotalWei),'funding_source_budget_exhausted');
   check(!stats.latest||now()-new Date(stats.latest).getTime()>=P.cycleIntervalSeconds*1000,'funding_cycle_not_due');
   const id=P.id+':'+(stats.n+1);
   const row=(await c.query("INSERT INTO claus_funding_cycles(id,policy_hash,approval,claim_wei,context,state) VALUES($1,$2,$3,$4,$5,'active') RETURNING *",[id,input.policyHash,input.approval,input.claimWei,{providerAddress:binding.address}])).rows[0];return cycle(row);
  }),
  async step(id,step){return one('SELECT id,transaction,context,state,receipt FROM claus_funding_steps WHERE cycle_id=$1 AND step=$2',[id,step]);},
  async allocation(id){return (await one('SELECT allocation FROM claus_funding_allocations WHERE cycle_id=$1',[id]))?.allocation??null;},
  observePrepaid:(id,observation)=>transaction(async c=>{
   const result=await c.query("UPDATE claus_funding_cycles SET context=jsonb_set(context,'{prepaidReconciliation}',$3::jsonb) WHERE id=$1 AND state='active' AND policy_hash=$2 RETURNING id",[id,fundingHash(P),JSON.stringify(observation)]);
   check(result.rows.length===1,'funding_cycle_inactive');
  }),
  reserveAllocation:(id,allocation)=>transaction(async c=>{
   const row=(await c.query("SELECT context FROM claus_funding_steps WHERE cycle_id=$1 AND step='receive' AND state='confirmed'",[id])).rows[0];
   const a=BigInt(allocation.prepaidMicro),cash=BigInt(allocation.cashMicro),minted=BigInt(allocation.mintedMicro);
   if(P.rail==='x402-wallet')check(a===0n,'funding_provider_deposit_disabled');
   check(row&&row.context.mintedMicro===allocation.mintedMicro&&a>=0n&&a<=BigInt(P.prepaidMaxPerCycleMicroUsdc)&&cash>=0n&&a+cash===minted,'funding_allocation_invalid');
   await c.query('INSERT INTO claus_funding_allocations(cycle_id,allocation) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,allocation]);
   return (await c.query('SELECT allocation FROM claus_funding_allocations WHERE cycle_id=$1',[id])).rows[0].allocation;
  }),
  reserveStep:(id,step,value)=>transaction(async c=>{
   check(['claim','swap','approve','burn','receive',...(P.rail==='x402-wallet'?[]:['prepaid'])].includes(step),'funding_step_denied');
   check((await c.query("SELECT id FROM claus_funding_cycles WHERE id=$1 AND state='active'",[id])).rows.length===1,'funding_cycle_inactive');
   const key=id+':'+step;
   await c.query('INSERT INTO claus_funding_steps(id,cycle_id,step,transaction,context) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[key,id,step,value.transaction,value.context]);
   const row=(await c.query('SELECT id,transaction,context,state,receipt FROM claus_funding_steps WHERE id=$1',[key])).rows[0];
   // Canonical SQL JSON comparison makes concurrent reservations deterministic.
   check((await c.query('SELECT transaction=$2::jsonb ok FROM claus_funding_steps WHERE id=$1',[key,JSON.stringify(value.transaction)])).rows[0].ok,'funding_original_transaction_conflict');return row;
  }),
  confirmStep:(id,step,receipt,context)=>transaction(async c=>{
   check(receipt?.finalized===true&&receipt.status==='success','funding_unfinalized_receipt');
   const row=(await c.query('SELECT * FROM claus_funding_steps WHERE cycle_id=$1 AND step=$2 FOR UPDATE',[id,step])).rows[0];check(row,'funding_original_step_missing');
   if(row.state==='confirmed'){check(row.receipt.transactionHash===receipt.transactionHash,'funding_receipt_conflict');return;}
   await c.query("UPDATE claus_funding_steps SET state='confirmed',receipt=$3,context=$4 WHERE cycle_id=$1 AND step=$2",[id,step,receipt,context]);
  }),
  fail:(id,step,receipt)=>transaction(async c=>{await c.query("UPDATE claus_funding_steps SET state='failed',receipt=$3 WHERE cycle_id=$1 AND step=$2",[id,step,receipt]);await c.query("UPDATE claus_funding_cycles SET state='failed' WHERE id=$1",[id]);}),
  creditAndGrant:(id,{deposit,amountMicroUsdc})=>transaction(async c=>{
   const cycle=(await c.query('SELECT * FROM claus_funding_cycles WHERE id=$1 FOR UPDATE',[id])).rows[0];check(cycle,'funding_cycle_missing');
   const old=(await c.query('SELECT * FROM claus_funding_credits WHERE cycle_id=$1',[id])).rows[0];if(old){check(old.transaction_hash===deposit.transactionHash&&String(old.amount)===amountMicroUsdc&&(old.evidence.providerCredit?.id??null)===(deposit.providerCredit?.id??null)&&(old.evidence.providerCredit?.transactionHash??null)===(deposit.providerCredit?.transactionHash??null),'funding_credit_conflict');return;}
   check(cycle.state==='active'&&cycle.policy_hash===fundingHash(P),'funding_cycle_inactive');
   validateFundingApproval(cycle.approval,{binding,now:now()});
   const amount=BigInt(amountMicroUsdc),step=(await c.query("SELECT * FROM claus_funding_steps WHERE cycle_id=$1 AND step='receive' AND state='confirmed'",[id])).rows[0];
   const allocation=(await c.query('SELECT allocation FROM claus_funding_allocations WHERE cycle_id=$1',[id])).rows[0]?.allocation;
   check(allocation&&allocation.mintedMicro===amountMicroUsdc,'funding_allocation_invalid');
   check(step&&step.receipt.transactionHash===deposit.transactionHash&&step.context.mintedMicro===amountMicroUsdc&&deposit.state==='credited'&&deposit.address===P.payer&&deposit.chainId===8453,'funding_deposit_not_verified');
   if(allocation.prepaidMicro==='0')check(deposit.rail==='x402'&&!deposit.providerCredit,'funding_deposit_not_verified');
   else{
    check(deposit.rail==='x402-and-prepaid'&&deposit.providerCredit,'funding_prepaid_credit_unresolved');
    const paid=(await c.query("SELECT receipt FROM claus_funding_steps WHERE cycle_id=$1 AND step='prepaid' AND state='confirmed'",[id])).rows[0]?.receipt;
    check(paid&&receivedUsdc(paid,8453,P.prepaidAddress,P.payer)===allocation.prepaidMicro,'funding_prepaid_transfer_mismatch');
    validateProviderCredit(deposit.providerCredit,paid,allocation.prepaidMicro,binding);
    check(!(await c.query("SELECT 1 FROM claus_funding_credits WHERE evidence->'providerCredit'->>'address'=$1 AND evidence->'providerCredit'->>'id'=$2",[binding.address,deposit.providerCredit.id])).rows.length,'funding_provider_credit_reused');
   }
   check(amount>0n&&amount<=BigInt(P.maxGrantPerCycleMicroUsdc),'funding_grant_bounds');
   const total=BigInt((await c.query('SELECT COALESCE(sum(amount),0)::text n FROM claus_funding_credits')).rows[0].n);
   check(total+amount<=BigInt(P.maxGrantTotalMicroUsdc),'funding_grant_total');
   const budget=(await c.query('SELECT * FROM claus_payment_budget WHERE id=true FOR UPDATE')).rows[0];
   check(budget&&BigInt(budget.ceiling)+amount<=BigInt(P.maximumLifetimeMicroUsdc),'funding_lifetime_cap');
   // This only extends authority backed by this unique settled deposit. It
   // never modifies committed, original request holds or network allocation.
   await c.query('INSERT INTO claus_funding_credits(cycle_id,transaction_hash,amount,evidence) VALUES($1,$2,$3,$4)',[id,deposit.transactionHash,amountMicroUsdc,deposit]);
   await c.query('UPDATE claus_payment_budget SET ceiling=ceiling+$1::bigint WHERE id=true',[amountMicroUsdc]);
   await c.query("UPDATE claus_funding_cycles SET state='completed',grant_micro=$2 WHERE id=$1",[id,amountMicroUsdc]);
  })
 };
}
