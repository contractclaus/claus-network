import {MANDATE,LIMITS,check,digest,termsHash} from './policy.mjs';
export const investmentId=value=>'capital-investment:'+digest(value.execution.escrow).slice(7);
export function investmentStore(pool){
 const transaction=async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const out=await fn(c);await c.query('COMMIT');return out;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
 async function lock(c){
  await c.query('SELECT id FROM claus_payment_budget WHERE id=true FOR UPDATE');
  const p=(await c.query('SELECT * FROM claus_capital_control WHERE id=true FOR UPDATE')).rows[0];
  check(p?.policy_hash===MANDATE&&p.state==='active','mandate_inactive');return p;
 }
 return {
  async active(){return (await pool.query("SELECT EXISTS(SELECT 1 FROM claus_capital_control WHERE id=true AND policy_hash=$1 AND state='active') active",[MANDATE])).rows[0].active;},
  async get(id){return (await pool.query('SELECT * FROM claus_capital_investments WHERE id=$1',[id])).rows[0]??null;},
  async signature(id){return (await pool.query('SELECT * FROM claus_capital_signatures WHERE id=$1',[id])).rows[0]??null;},
  async overview(){const r=await pool.query('SELECT id,project_id,amount::text,state,spent::text,created_at,settled_at FROM claus_capital_investments ORDER BY created_at DESC LIMIT 101');return {investments:r.rows.slice(0,100),truncated:r.rows.length>100};},
  async reserve({capital,proof,decision,adapterHash}){
   const id=investmentId(capital),sid=id+':'+capital.action,input={capital,proof,decision,adapterHash},inputHash=digest(input);
   return transaction(async c=>{
    const p=await lock(c);let row=(await c.query('SELECT * FROM claus_capital_investments WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!row){
     check(capital.action==='fund','original_investment_required');
     check(p.cash_started_at&&Date.now()-new Date(p.cash_started_at).getTime()<20000,'cash_stale');
     const sums=(await c.query('SELECT COALESCE(sum(COALESCE(spent,amount)),0)::text total,COALESCE(sum(COALESCE(spent,amount)) FILTER(WHERE project_id=$1),0)::text project FROM claus_capital_investments',[capital.terms.projectId])).rows[0];
     const amount=BigInt(capital.execution.amount);
     check(BigInt(sums.total)+amount<=BigInt(LIMITS.investment)&&BigInt(sums.project)+amount<=BigInt(LIMITS.perProject),'investment_budget');
     const holds=(await c.query(`SELECT COALESCE(sum(reserved_max) FILTER(WHERE accounted_cost IS NULL),0)+COALESCE(sum(accounted_cost) FILTER(WHERE capital_accounted_at>=$1::timestamptz-interval '5 seconds'),0) AS held FROM (
      SELECT reserved_max,accounted_cost,capital_accounted_at FROM claus_inference UNION ALL SELECT reserved_max,accounted_cost,capital_accounted_at FROM claus_credit_work UNION ALL SELECT reserved_max,accounted_cost,capital_accounted_at FROM claus_credit_requests) l`,[p.cash_started_at])).rows[0].held;
     // The whole unspent one-time allocation is already protected from inference.
     check(BigInt(p.cash_micro)-BigInt(holds)-BigInt(p.reserve_micro)>=BigInt(LIMITS.investment)-BigInt(sums.total),'investment_cash');
     row=(await c.query("INSERT INTO claus_capital_investments(id,project_id,terms_hash,adapter_hash,amount,state,binding) VALUES($1,$2,$3,$4,$5,'reserved',$6::jsonb) RETURNING *",[id,capital.terms.projectId,termsHash(capital),adapterHash,capital.execution.amount,JSON.stringify(input)])).rows[0];
    }
    check(row.terms_hash===termsHash(capital)&&row.adapter_hash===adapterHash,'original_terms_changed');
    if(capital.action==='release')check(row.state==='settled'&&row.spent===capital.execution.amount,'funded_original_required');
    await c.query("INSERT INTO claus_capital_signatures(id,investment_id,action,input_hash,input,state) VALUES($1,$2,$3,$4,$5::jsonb,'reserved') ON CONFLICT DO NOTHING",[sid,id,capital.action,inputHash,JSON.stringify(input)]);
    const signature=(await c.query('SELECT * FROM claus_capital_signatures WHERE id=$1',[sid])).rows[0];
    check(signature?.input_hash===inputHash,'original_signature_conflict');return signature;
   });
  },
  async claim(id,payloadHash){return transaction(async c=>{await lock(c);return (await c.query("UPDATE claus_capital_signatures SET state='signing',payload_hash=$2 WHERE id=$1 AND (state='reserved' OR (state='signing' AND payload_hash=$2)) RETURNING id",[id,payloadHash])).rowCount===1;});},
  async save(id,signature){check(/^0x[0-9a-f]{130}$/i.test(signature),'signature_format');return transaction(async c=>{const r=await c.query("UPDATE claus_capital_signatures SET state='signed',signature=$2 WHERE id=$1 AND (state='signing' OR (state='signed' AND signature=$2)) RETURNING investment_id,action",[id,signature]);check(r.rowCount===1,'signature_save_conflict');if(r.rows[0].action==='fund')await c.query("UPDATE claus_capital_investments SET state='submitted' WHERE id=$1 AND state='reserved'",[r.rows[0].investment_id]);});},
  async reconcile(id,observed){check(observed.finalized,'finalized_observation_required');return transaction(async c=>{
   await c.query('SELECT id FROM claus_payment_budget WHERE id=true FOR UPDATE');
   const row=(await c.query('SELECT * FROM claus_capital_investments WHERE id=$1 FOR UPDATE',[id])).rows[0];check(row,'original_missing');
   const wasFunded=[1,2,3].includes(observed.state)&&observed.used;
   const unusedExpired=observed.state===0&&!observed.used&&observed.timestamp>row.binding.capital.terms.expiresAt;
   if(row.spent===null&&(wasFunded||unusedExpired))await c.query("UPDATE claus_capital_investments SET state=$2,spent=$3,settled_at=clock_timestamp() WHERE id=$1",[id,wasFunded?'settled':'cancelled',wasFunded?row.amount:'0']);
   // A refund never replenishes the one-time investment authority.
   return {id,observation:observed,spent:wasFunded?row.amount:row.spent};
  });}
 };
}
