import type {LabQuery} from './lab-db.js';
type RecoveryState={status:string;next_at:string;updated_at:string;lease_until?:string|null};
type RecoveryPoll={next_poll_at:string;lease_until?:string|null};

// The social poll has its own deadline. A failed poll must not wait for the
// next scheduled thought/post before the runtime can recover.
export function recoveryCandidate(state:RecoveryState,poll:RecoveryPoll|null,mentions:boolean,now=Date.now()) {
  const overdue=now-300000;
  if(!['working','waiting','waiting_for_effect'].includes(state.status)||state.lease_until&&Date.parse(state.lease_until)>now)return false;
  if(Date.parse(state.next_at)<overdue)return true;
  return mentions&&state.status==='waiting'&&Date.parse(state.updated_at)<overdue&&!!poll
    &&Date.parse(poll.next_poll_at)<overdue&&(!poll.lease_until||Date.parse(poll.lease_until)<now);
}


// Re-read current policy and lease state inside the atomic update. A cron that
// read the old configuration must not advance a now paused/disabled runtime.
export async function recoverOverdueGeneration(db:LabQuery,expected:number,mentions=false){
 if(!Number.isSafeInteger(expected)||expected<0)throw Error('invalid_generation');
 const {rows}=await db.query(`UPDATE claus_state SET generation=generation+1,updated_at=now()
 WHERE id=1 AND generation=$1 AND status IN ('working','waiting','waiting_for_effect')
 AND (lease_until IS NULL OR lease_until<now())
 AND EXISTS(SELECT 1 FROM (SELECT content FROM claus_config ORDER BY revision DESC LIMIT 1) c WHERE c.content->'settings'->>'enabled'='true')
 AND (next_at<now()-interval '5 minutes' OR ($2 AND status='waiting' AND updated_at<now()-interval '5 minutes'
   AND EXISTS(SELECT 1 FROM (SELECT content FROM claus_config ORDER BY revision DESC LIMIT 1) c WHERE c.content->'policy'->'capabilities'->>'xRead'='true' AND c.content->'policy'->'capabilities'->>'xReply'='true')
   AND EXISTS(SELECT 1 FROM claus_x_poll WHERE id=1 AND next_poll_at<now()-interval '5 minutes' AND (lease_until IS NULL OR lease_until<now()))))
 RETURNING generation`,[expected,mentions]);
 return rows[0]?.generation as number|undefined;
}
