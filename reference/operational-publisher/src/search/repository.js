import {Pool,neonConfig} from '@neondatabase/serverless';
import {SearchError,dailyLimit} from './policy.js';
export function createSearchRepository(transaction){
 return {
  async reserve(request){return transaction(async q=>{
   await q.query('SELECT pg_advisory_xact_lock(7439035)');
   const old=(await q.query('SELECT request_hash FROM claus_search_requests WHERE id=$1',[request.id])).rows[0];
   if(old)throw new SearchError(old.request_hash===request.hash?'search_request_already_reserved':'search_request_conflict',409);
   const row=(await q.query("SELECT (now() AT TIME ZONE 'UTC')::date::text AS day")).rows[0];
   const {used}=await usage(q,row.day);
   if(used>=dailyLimit)throw new SearchError('search_daily_limit',429);
   await q.query("INSERT INTO claus_search_requests(id,request_hash,day,status) VALUES($1,$2,$3,'started')",[request.id,request.hash,row.day]);
  });},
  async finish(id,status){return transaction(q=>q.query("UPDATE claus_search_requests SET status=$2,completed_at=now() WHERE id=$1 AND status='started'",[id,status]));},
  async status(){return transaction(async q=>{
   const row=(await q.query("SELECT (now() AT TIME ZONE 'UTC')::date::text AS day")).rows[0];
   const {used}=await usage(q,row.day);
   return {day:row.day,limit:dailyLimit,used,remaining:Math.max(0,dailyLimit-used)};
  });}
 };
}
async function usage(q,day){
 const row=(await q.query("SELECT COALESCE((SELECT used FROM claus_search_baselines WHERE day=$1),0)::int + (SELECT count(*)::int FROM claus_search_requests WHERE day=$1) AS used",[day])).rows[0];
 return {used:Number(row.used)};
}
let instance;
export function searchRepository(){
 if(instance)return instance;
 if(typeof WebSocket!=='undefined')neonConfig.webSocketConstructor=WebSocket;
 const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2,connectionTimeoutMillis:10000,idleTimeoutMillis:10000});pool.on('error',()=>{});
 instance=createSearchRepository(async fn=>{
  const q=await pool.connect();
  try{await q.query('BEGIN');await q.query("SET LOCAL statement_timeout='12000ms'");const result=await fn(q);await q.query('COMMIT');return result;}
  catch(e){await q.query('ROLLBACK').catch(()=>{});throw e;}finally{q.release();}
 });
 return instance;
}
