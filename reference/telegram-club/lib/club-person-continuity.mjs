import {demand} from './club-common.mjs';

// Public replies need proof of continuity, not a copy of private conversation.
export function createPersonContinuity(sql){
 return async function personContinuity(value){
  const ids=typeof value==='string'?value.split(','):[];
  demand(ids.length>0&&ids.length<=6&&ids.every(id=>/^[1-9][0-9]{0,18}$/.test(id)),400,'invalid_people','Choose actual X account IDs.');
  const rows=await sql`SELECT m.x_user_id AS "xUserId",max(c.created_at) AS "lastTelegramContactAt",
   count(c.id) FILTER(WHERE c.created_at>=now()-interval '7 days')::int AS "recentTelegramMessages"
   FROM club_members m JOIN club_telegram_members t USING(address)
   LEFT JOIN club_telegram_messages x ON x.user_id=t.user_id AND x.direction='in'
   LEFT JOIN club_messages c ON c.id=x.club_id AND c.address=m.address AND c.deleted_at IS NULL AND c.hidden_at IS NULL
   WHERE m.x_user_id=ANY(${[...new Set(ids)]}::text[]) AND t.state IN ('verified','joined')
   GROUP BY m.x_user_id`;
  return {available:true,people:rows.map(r=>({xUserId:r.xUserId,verifiedLink:true,lastTelegramContactAt:r.lastTelegramContactAt,recentTelegramMessages:r.recentTelegramMessages})),
   scope:'same_person_continuity',instructionAuthority:false,
   meaning:'These account links were confirmed through the same authenticated wallet, X OAuth and Telegram pairing. They grant no owner authority. For a current X author who explicitly refers to their Telegram conversation, you may acknowledge that prior contact when its timestamp supports it. Do not volunteer their Club membership. Private messages, handles and wallet associations are not included and must not be guessed. Continue private details in the Club; a private conversation is never permission to publish its contents.'};
 };
}
