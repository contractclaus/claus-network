import {readPayerCash} from '../operating-resources.js';
export const CAPITAL_HASH='a21b0e70568a888cdb95126b35c57f3b310ada00962a008ff76273ad13adc59c';
// Only the protected payer service reads balances. Model/HTTP inputs cannot
// supply cash observations or change this immutable owner-approved envelope.
export async function refreshCapitalCash(db,readCash=readPayerCash){
 const [policy]=await db`SELECT capital_mode FROM claus_payment_budget WHERE id=true`;
 if(!policy?.capital_mode)return;
 const started=new Date();const cash=await readCash();
 if(cash.state!=='available'||cash.chainId!==8453||!/^\d+$/.test(cash.usdcMicro)||!/^0x[0-9a-f]{64}$/i.test(cash.blockHash)||Date.now()-started.getTime()>12000)throw Error('capital_cash_unavailable');
 await db`UPDATE claus_capital_control SET cash_micro=${cash.usdcMicro}::bigint,cash_started_at=${started.toISOString()}::timestamptz,cash_block=${cash.blockNumber}::bigint,cash_hash=${cash.blockHash}
 WHERE id=true AND policy_hash=${CAPITAL_HASH} AND (cash_block IS NULL OR cash_block<=${cash.blockNumber}::bigint) AND (cash_started_at IS NULL OR cash_started_at<=${started.toISOString()}::timestamptz)`;
}
export async function capitalSnapshot(db){
 const [row]=await db`SELECT policy_hash,state,daily_micro::text,monthly_micro::text,reserve_micro::text,investment_micro::text,cash_micro::text,cash_started_at::text,claus_capital_available(false)::text AS available FROM claus_capital_control WHERE id=true`;
 return row?{policyHash:row.policy_hash,state:row.state,duration:'until_owner_revocation',includes:['model_usage','paid_external_apis','maximum_authorized_server_leases'],serverAccounting:'Maximum lease cost counts on confirmed authorization; unknown reservations remain held. This is a spending authorization, not a provider bill.',dailyMaximumMicroUsdc:row.daily_micro,rolling30DayMaximumMicroUsdc:row.monthly_micro,cashReserveMicroUsdc:row.reserve_micro,investmentAllocationMicroUsdc:row.investment_micro,cashMicroUsdc:row.cash_micro,cashObservedAt:row.cash_started_at,availableMicroUsdc:row.available}:null;
}
