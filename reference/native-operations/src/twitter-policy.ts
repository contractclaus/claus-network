// These limits belong to the service, not to public posts or model decisions.
export const twitterTools = new Set([
  'read_publication','read_knowledge','read_reference','read_url','read_x','read_x_account','read_x_thread',
  'read_mentions','recall_conversation','resolve_mention','publish_reply','publish_post',
  'draft_post','remember','recall','finish',
  // Visibility only: execution still checks current capabilities, identity and channel.
  'investment_proposal','stage_development','develop_project','read_network','build_network','finish_mission','network_work','network_care','read_network_code','change_network_code','work_wallet','trade_program',
  'read_operational_code','change_operational_code','rollback_operational_code','run_network_program','resume_network_operation',
  'play_gotchi','read_gotchi',
  'read_chain','read_contract_source','read_market','read_image','generate_image','review_image','prepare_gif'
]);
export const xUserFields = 'username,verified,verified_type';
export const originalPostIntervalMs = 2 * 60 * 60 * 1000;
export const replyVerificationTypes = ['blue','business'];

export function eligibleBadge(author:any) {
  return author?.verified === true && replyVerificationTypes.includes(author?.verified_type);
}

export function conversationExclusion(post:any):string|null {
  // Tone is judged with the real conversation in the ordinary model turn.
  // Keyword bans discard negation, self-deprecating jokes and security reports.
  // Keep this owner's explicit private-identity exclusion deterministic.
  const text=String(post?.text??'').normalize('NFKC').replace(/[\u200B-\u200F\u2060\uFEFF]/g,'').toLowerCase();
  if(/\b(?:hazar\w*|hazard\w*)\b/.test(text)&&/\b(?:behind|secret\w*|launch\w*|creat\w*|own\w*|founder|built|control\w*|dahinter)\b/.test(text))return 'identity_bait';
  return null;
}

export function replyExclusion(post:any):string|null {
  return !eligibleBadge(post?.authorVerification)?'verified_audience_required':conversationExclusion(post);
}

export function originalPostSchedule(startedAt:string,lastPostAt:string|null,now=Date.now()) {
  const started=Date.parse(startedAt),last=lastPostAt?Date.parse(lastPostAt):0;
  if(!Number.isFinite(started)||!Number.isFinite(last))throw Error('invalid_social_schedule');
  const nextAt=new Date(Math.max(started,last)+originalPostIntervalMs).toISOString();
  return {due:now>=Date.parse(nextAt),nextAt,intervalHours:originalPostIntervalMs/3600000,lastPostAt};
}
