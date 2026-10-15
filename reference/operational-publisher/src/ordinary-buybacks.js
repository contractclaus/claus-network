// Fixed-purpose ordinary burn/FOMO batches. Separate from the discontinued arbitrage program.
import fs from 'node:fs';
import {createPublicClient,http,parseAbi,encodeFunctionData,decodeFunctionData,decodeEventLog,parseTransaction,keccak256} from 'viem';
import {mainnet} from 'viem/chains';
import {privateKeyToAccount} from 'viem/accounts';
import {neon} from '@neondatabase/serverless';
import {walletService} from './wallet.js';
import {walletRepository} from './wallet-store.js';
import {address} from './policy.js';
import {WEATHER} from './weather-proof.js';
import {maintenanceFees} from './maintenance.js';
import {buybackBalances} from './ordinary-buyback-balance.js';
import {verifyPendingGrowth,verifyExpiredBatch} from './ordinary-buyback-recovery.js';

const live=JSON.parse(fs.readFileSync(new URL('../config/ordinary-buybacks.json',import.meta.url)));
const PREFIX='ordinary-buyback:';
export const ORDINARY_BUYBACK_ABI=parseAbi([
 'function pendingBurnEth() view returns(uint256)','function pendingFomoEth() view returns(uint256)',
 'function batchBuybacksEnabled() pure returns(bool)',
 'function processBuybacksGuarded(uint256 minimumTokensPerEth,uint256 maximumPendingEth,uint256 deadline) returns(uint256 spentEth,uint256 receivedTokens)',
 'event BuybackBatchProcessed(uint256 spentEth,uint256 receivedTokens)']);
const abi=ORDINARY_BUYBACK_ABI;
const limits=c=>({gasBudget:BigInt(c.gasBudgetWei),reserve:BigInt(c.reserveWei),maxGas:BigInt(c.maxGas),maxFee:BigInt(c.maxFeePerGasWei)});
const sameHex=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();

// A failed price/balance-growth guard is safe to re-quote only after proving the exact
// canonical transaction reverted. Unknown errors and missing traces stay shut.
async function recoverableBatchRevert(client,latest,receipt){
 try{
  if(!sameHex(receipt.transactionHash,latest.signed?.hash))return false;
  const [tx,trace]=await Promise.all([
   client.getTransaction({hash:receipt.transactionHash}),
   client.request({method:'debug_traceTransaction',params:[receipt.transactionHash,{tracer:'callTracer'}]}),
  ]);
  if(!sameHex(tx.hash,receipt.transactionHash)||!sameHex(tx.blockHash,receipt.blockHash)||tx.blockNumber!==receipt.blockNumber||
    !sameHex(tx.from,address)||!sameHex(tx.to,WEATHER.hook)||tx.value!==0n||
    trace.type!=='CALL'||trace.error!=='execution reverted'||
    !sameHex(trace.from,tx.from)||!sameHex(trace.to,tx.to)||!sameHex(trace.input,tx.input))return false;
  const call=decodeFunctionData({abi,data:tx.input});
  if(call.functionName!=='processBuybacksGuarded'||call.args[0]<=0n||call.args[1]<=0n)return false;
  const block=await client.getBlock({blockNumber:receipt.blockNumber});
  if(!sameHex(block.hash,receipt.blockHash))return false;
  if(sameHex(trace.output,'0x873d73a9'))return true;
  return await verifyPendingGrowth(client,trace,call.args,block)||await verifyExpiredBatch(client,trace,call.args,block);
 }catch{return false;}
}

// New trades can accrue fees before inclusion. Bound that growth separately
// from the unchanged minimum token-per-ETH price and cumulative gas budget.
export const batchPendingLimit=pending=>pending*2n;

// Same 20% gas margin used by walletService. This is a reservation, never
// receipt consumption. The final signing boundary independently repeats it.
export function boundedBatchGas(estimate,maximum){
 if(typeof estimate!=='bigint'||estimate<21000n||typeof maximum!=='bigint'||maximum<21000n)return null;
 const gas=(estimate*120n+99n)/100n;
 return gas<=maximum?gas:null;
}

export function batchReadiness({config,now,pending,firstSeenAt,gasCost,spent,balance}){
 if(!config.enabled||!config.implementation||!config.runtimeHash||BigInt(config.gasBudgetWei)<=0n)return 'not_configured';
 const l=limits(config);
 if(now>=config.validUntil)return 'authorization_expired';
 if(pending<=0n)return 'waiting_for_batch';
 if(gasCost<=0n||spent<0n||spent+gasCost>l.gasBudget)return 'gas_budget_exhausted';
 if(balance<l.reserve+gasCost)return 'waiting_for_operating_funds';
 const aged=firstSeenAt!==null&&now-firstSeenAt>=config.waitSeconds;
 const maxCost=aged?config.timeoutCostBps:config.maximumCostBps;
 if(!Number.isInteger(maxCost)||maxCost<1||maxCost>2500)throw Error('ordinary_buyback_invalid_economics');
 return gasCost*10000n>pending*BigInt(maxCost)?'waiting_for_economic_batch':'ready';
}

export function assertOrdinaryBuyback(tx,config,spent,now){
 const l=limits(config);
 let call;try{call=decodeFunctionData({abi,data:tx.data});}catch{throw Error('ordinary_buyback_invalid_call');}
 if(!config.enabled||now>=config.validUntil||tx.chainId!==1||tx.to?.toLowerCase()!==WEATHER.hook.toLowerCase()||
   tx.type!=='eip1559'||(tx.value??0n)!==0n||tx.gas<=0n||tx.gas>l.maxGas||
   tx.maxFeePerGas<=0n||tx.maxFeePerGas>l.maxFee||tx.maxPriorityFeePerGas<0n||tx.maxPriorityFeePerGas>tx.maxFeePerGas||
   call.functionName!=='processBuybacksGuarded'||call.args[0]<=0n||call.args[1]<=0n||
   call.args[2]<=BigInt(now)||call.args[2]>BigInt(now)+300n||spent+tx.gas*tx.maxFeePerGas>l.gasBudget)
  throw Error('ordinary_buyback_transaction_refused');
 return call.args;
}

function store(){
 const sql=neon(process.env.DATABASE_URL);
 return {
  async firstSeen(pending,now){
   // This row is only a clock, never a budget or a source of transaction instructions.
   await sql`CREATE TABLE IF NOT EXISTS claus_ordinary_buyback_clock(id integer PRIMARY KEY,first_seen bigint,last_tx text)`;
   const rows=await sql`INSERT INTO claus_ordinary_buyback_clock(id,first_seen) VALUES(1,${pending>0n?now:null})
     ON CONFLICT(id) DO UPDATE SET first_seen=CASE WHEN ${pending>0n} THEN COALESCE(claus_ordinary_buyback_clock.first_seen,EXCLUDED.first_seen) ELSE NULL END RETURNING first_seen`;
   return rows[0].first_seen===null?null:Number(rows[0].first_seen);
  },
  async processed(hash,now,pending){
   await sql`UPDATE claus_ordinary_buyback_clock SET first_seen=${pending>0n?now:null},last_tx=${hash}
    WHERE id=1 AND last_tx IS DISTINCT FROM ${hash}`;
  },
  async latest(){return (await sql`SELECT * FROM claus_wallet_actions WHERE id LIKE 'ordinary-buyback:%' ORDER BY created_at DESC,id DESC LIMIT 1`)[0]??null;},
  async failures(){
   const rows=await sql`SELECT status FROM claus_wallet_actions WHERE id LIKE 'ordinary-buyback:%' AND signed IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 5`;
   let count=0;for(const row of rows){if(row.status!=='reverted')break;count++;}return count;
  },
  async spent(){
   const rows=await sql`SELECT signed,result FROM claus_wallet_actions WHERE id LIKE 'ordinary-buyback:%' AND signed IS NOT NULL`;
   return rows.reduce((total,row)=>{const r=row.result?.receipt;if(r)return total+BigInt(r.gasUsed)*BigInt(r.effectiveGasPrice);
    const tx=parseTransaction(row.signed.raw);return total+tx.gas*tx.maxFeePerGas;},0n);
  },
 };
}

export async function processOrdinaryBuybacks(deps={}){
 const config=deps.config??live;
 // Disabled before any private key, database or network access.
 if(!config.enabled||!config.implementation||!config.runtimeHash||BigInt(config.gasBudgetWei)<=0n)return {status:'not_configured'};
 if(!Number.isInteger(config.slippageBps)||config.slippageBps<0||config.slippageBps>100||
   !Number.isInteger(config.waitSeconds)||config.waitSeconds<60)throw Error('ordinary_buyback_invalid_config');
 const l=limits(config),c=deps.client??createPublicClient({chain:mainnet,transport:http(process.env.ETHEREUM_RPC_URL,{timeout:15000,retryCount:0})});
 const account=deps.account??privateKeyToAccount(process.env.SIGNER_PRIVATE_KEY);
 if(account.address.toLowerCase()!==address.toLowerCase()||await c.getChainId()!==1)throw Error('ordinary_buyback_wallet_mismatch');
 const repo=deps.repository??walletRepository(),state=deps.state??store();
 const approved=async()=>{
  const word=await c.getStorageAt({address:WEATHER.hook,slot:WEATHER.slot});
  const code=await c.getCode({address:config.implementation});
  return !!word&&word.slice(-40).toLowerCase()===config.implementation.slice(2).toLowerCase()&&!!code&&keccak256(code)===config.runtimeHash;
 };
 const balances=async()=>buybackBalances(
  await c.readContract({address:WEATHER.hook,abi,functionName:'pendingBurnEth'}),
  await c.readContract({address:WEATHER.hook,abi,functionName:'pendingFomoEth'}),
  BigInt(config.reserveFloorWei??'0'));
 const pending=async()=>(await balances()).spendable;
 const service=deps.service??walletService({account:{...account,signTransaction:async tx=>{
  const now=Number((await c.getBlock()).timestamp),spent=await state.spent();
  const args=assertOrdinaryBuyback(tx,config,spent,now);
  if(!await approved())throw Error('ordinary_buyback_state_changed');
  const p=await pending(),firstSeenAt=await state.firstSeen(p,now);
  const fresh=await c.simulateContract({account:address,address:WEATHER.hook,abi,functionName:'processBuybacksGuarded',args});
  if(batchReadiness({config,now,pending:fresh.result[0],firstSeenAt,gasCost:tx.gas*tx.maxFeePerGas,spent,balance:await c.getBalance({address})})!=='ready')
   throw Error('ordinary_buyback_state_changed');
  return account.signTransaction(tx);
 }},clients:{1:{...c,estimateFeesPerGas:()=>maintenanceFees(c)}},repository:repo,
 policy:async()=>({enabled:true,mode:'production',chainWrite:true,externalTransfer:true,blockingRules:[],revision:'ordinary-buyback-v1'})});
 const verify=async observed=>{
  if(observed.status!=='included')return {status:observed.status,actionId:observed.id,transactionHash:observed.result?.transactionHash};
  const receipt=await c.getTransactionReceipt({hash:observed.result.transactionHash});
  const canonical=await c.getBlock({blockNumber:receipt.blockNumber});
  if(canonical.hash!==receipt.blockHash)return {status:'requires_reconciliation'};
  const event=receipt.logs.some(log=>{
   if(log.address.toLowerCase()!==WEATHER.hook.toLowerCase())return false;
   try{const e=decodeEventLog({abi,data:log.data,topics:log.topics});return e.eventName==='BuybackBatchProcessed'&&e.args.spentEth>0n&&e.args.receivedTokens>0n;}catch{return false;}
  });
  if(!event||receipt.status!=='success')return {status:'requires_reconciliation'};
  await state.processed(receipt.transactionHash,Number(canonical.timestamp),await pending());
  return {status:'completed',transactionHash:receipt.transactionHash};
 };
 const active=await repo.active(1);
 if(active){
  if(!active.startsWith(PREFIX))return {status:'waiting_for_existing_transaction'};
  const observed=await service.status(active);
  // Reconcile signed requests; never regenerate or replace a transaction here.
  if(observed.status==='included')return verify(observed);
  return {status:'requires_reconciliation',actionId:active};
 }
 const latest=await state.latest();
 if(latest?.signed){
  const observed=await service.status(latest.id);
  if(observed.status==='reverted'){
   const receipt=await c.getTransactionReceipt({hash:observed.result.transactionHash});
   const canonical=await c.getBlock({blockNumber:receipt.blockNumber});
   if(receipt.status!=='reverted'||canonical.hash!==receipt.blockHash)return {status:'requires_reconciliation',actionId:latest.id};
   const failures=await state.failures();
   if(!Number.isInteger(config.maxConsecutiveFailures)||config.maxConsecutiveFailures<1||config.maxConsecutiveFailures>2||
     !Number.isInteger(failures)||failures<1||!Number.isInteger(config.retryDelaySeconds)||
     config.retryDelaySeconds<600||config.retryDelaySeconds>3600)return {status:'failure_review_required',actionId:latest.id};
   // Proven price volatility or accrued-balance growth must not permanently stop processing. Space retries
   // by 10/20/40/60 minutes; every retry still passes all existing financial
   // limits and a newly simulated quote, including the final signing check.
   const delay=Math.min(3600,config.retryDelaySeconds*2**Math.min(failures-1,3));
   const retryAt=Number(canonical.timestamp)+delay;
   if(Number((await c.getBlock()).timestamp)<retryAt)return {status:'retry_cooldown',actionId:latest.id,retryAt,consecutiveFailures:failures};
   if(!await recoverableBatchRevert(c,latest,receipt))return {status:'failure_review_required',actionId:latest.id,reason:'unclassified_revert'};
  }else{
   const verified=await verify(observed);
   if(verified.status!=='completed')return {status:'requires_reconciliation',actionId:latest.id};
  }
 }
 const now=Number((await c.getBlock()).timestamp);
 if(now>=config.validUntil)return {status:'authorization_expired'};
 if(!await approved())return {status:'awaiting_activation'};
 if(!await c.readContract({address:WEATHER.hook,abi,functionName:'batchBuybacksEnabled'}))return {status:'awaiting_activation'};
 // A crash after preparation is recoverable using the same request. The wallet
 // re-simulates and the signing boundary rechecks price, time, code and budget.
 // If expired it becomes a proven unsigned rejection, not a new signature.
 if(latest?.status==='prepared'&&!latest.signed)return verify({...await service.execute(latest.id),id:latest.id});
 const observed=await balances(),p=observed.spendable,firstSeenAt=await state.firstSeen(p,now);
 if(p===0n)return {status:'waiting_for_batch'};
 const [fees,spent,balance]=await Promise.all([maintenanceFees(c),state.spent(),c.getBalance({address})]);
 if(fees.maxFeePerGas>l.maxFee)return {status:'waiting_for_lower_gas'};
 // Skip provably unaffordable work cheaply. The 21k floor only rejects; it
 // never authorizes spending. Readiness below uses the full padded estimate.
 const readiness=batchReadiness({config,now,pending:p,firstSeenAt,gasCost:21000n*fees.maxFeePerGas,spent,balance});
 if(readiness!=='ready')return {status:readiness};
 // Only a positively recorded, unsigned rejection can be superseded. Prepared,
 // signing or uncertain rows must be reconciled rather than silently discarded.
 if(latest&&!latest.signed&&latest.status!=='included'&&
   !(latest.status==='rejected'&&latest.result?.signed===false))return {status:'requires_reconciliation',actionId:latest.id};
 const maximumPending=batchPendingLimit(observed.raw),deadline=BigInt(now+180);
 const quote=await c.simulateContract({account:address,address:WEATHER.hook,abi,functionName:'processBuybacksGuarded',args:[1n,maximumPending,deadline]});
 const minimum=quote.result[0]>0n?quote.result[1]*10n**18n*BigInt(10000-config.slippageBps)/quote.result[0]/10000n:0n;
 if(minimum<=0n||quote.result[0]<=0n)return {status:'waiting_for_batch'};
 const data=encodeFunctionData({abi,functionName:'processBuybacksGuarded',args:[minimum,maximumPending,deadline]});
 const estimate=await c.estimateGas({account:address,to:WEATHER.hook,data,value:0n,...fees});
 const gas=boundedBatchGas(estimate,l.maxGas);
 if(gas===null)return {status:'waiting_for_bounded_gas'};
 const boundedReadiness=batchReadiness({config,now,pending:quote.result[0],firstSeenAt,gasCost:gas*fees.maxFeePerGas,spent,balance});
 if(boundedReadiness!=='ready')return {status:boundedReadiness};
 const id=PREFIX+String(latest?BigInt(latest.id.slice(PREFIX.length))+1n:1n);
 await service.prepare(id,{chainId:1,to:WEATHER.hook,value:'0',data,checks:[]});
 const result=await service.execute(id);
 return verify({...result,id});
}
