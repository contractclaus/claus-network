import {demand} from './club-common.mjs';

// Kept separate from presentation: a ballot is still one wallet, backed by its
// opening snapshot. No administrator or service identity gets an extra vote.
export function createClubBallots(sql,write){
 return {
  async eligible(address,id){
   const [poll]=await sql`SELECT p.*,(SELECT extract(epoch FROM max(created_at))::text FROM club_votes WHERE poll_id=p.id AND address=${address}) AS ballot_version FROM club_polls p WHERE p.id=${id}`;
   demand(poll,404,'poll_missing','This vote is no longer available.');
   demand(!poll.closed&&new Date(poll.ends_at)>new Date(),409,'poll_closed','This vote has ended.');
   const ids=(await sql`SELECT token_id FROM club_eligibility WHERE poll_id=${id} AND address=${address}`).map(x=>x.token_id);
   return {poll,ids};
  },
  async vote(address,id,choice,ids,{previousVote,sessionHash,csrf}={}){
   demand(ids.length,403,'no_voting_weight','This wallet no longer holds or stakes an NFT that qualified when this vote opened.');
   demand(previousVote===null||typeof previousVote==='string'&&/^\d{1,15}\.\d{1,6}$/.test(previousVote),409,'vote_refresh_required','Refresh the page to vote with the latest version.');
   demand(Number.isInteger(choice)&&choice>=0,400,'invalid_choice','Choose an option.');
   // Guard locks the member, then lock the poll and session. A closed poll,
   // revoked login or newer ballot cannot be overwritten after a slow RPC read.
   const queries=[sql`SELECT id FROM club_polls WHERE id=${id} FOR UPDATE`];
   if(sessionHash)queries.push(sql`SELECT token_hash FROM club_sessions WHERE token_hash=${sessionHash} AND address=${address} AND csrf=${csrf} AND expires_at>clock_timestamp() FOR SHARE`);
   queries.push(sql`INSERT INTO club_votes(poll_id,token_id,address,choice)
    SELECT e.poll_id,e.token_id,${address},${choice} FROM club_eligibility e JOIN club_polls p ON p.id=e.poll_id
    WHERE p.id=${id} AND p.ends_at>clock_timestamp() AND NOT p.closed AND e.address=${address} AND e.token_id=ANY(${ids}::int[]) AND ${choice}<jsonb_array_length(p.options)
    AND (SELECT extract(epoch FROM max(created_at))::text FROM club_votes WHERE poll_id=${id} AND address=${address}) IS NOT DISTINCT FROM ${previousVote}::text
    AND (${!sessionHash} OR EXISTS(SELECT 1 FROM club_sessions WHERE token_hash=${sessionHash??null} AND address=${address} AND csrf=${csrf??null} AND expires_at>clock_timestamp()))
    AND (${!sessionHash} OR EXISTS(SELECT 1 FROM club_members WHERE address=${address} AND x_user_id IS NOT NULL AND username IS NOT NULL AND x_username IS NOT NULL))
    ON CONFLICT(poll_id,token_id) DO UPDATE SET choice=excluded.choice,created_at=clock_timestamp() WHERE club_votes.address=excluded.address RETURNING token_id,extract(epoch FROM created_at)::text AS ballot_version`);
   const results=await write(address,queries,'action','polls'),rows=results.at(-1);
   if(!rows.length){
    if(sessionHash){
     demand((await sql`SELECT 1 FROM club_sessions WHERE token_hash=${sessionHash} AND address=${address} AND csrf=${csrf} AND expires_at>clock_timestamp()`).length,401,'session_required','Sign in again to vote.');
     demand((await sql`SELECT 1 FROM club_members WHERE address=${address} AND x_user_id IS NOT NULL AND username IS NOT NULL AND x_username IS NOT NULL`).length,403,'x_required','Connect X to vote.');
    }
    const [poll]=await sql`SELECT closed,ends_at FROM club_polls WHERE id=${id}`;
    demand(poll&&!poll.closed&&new Date(poll.ends_at)>new Date(),409,'poll_closed','This vote has ended.');
    demand(false,409,'vote_changed','Your vote changed in another tab. Check your current choice and try again.');
   }
   return {weight:1,choice,ballotVersion:rows.map(r=>r.ballot_version).sort().at(-1)};
  }
 };
}
