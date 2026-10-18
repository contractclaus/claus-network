// These limits belong to the service, not to public posts or model decisions.
export const twitterTools = new Set([
  'read_publication','read_knowledge','read_reference','read_url','read_x','read_x_account','read_x_thread',
  'read_mentions','recall_conversation','resolve_mention','publish_reply','publish_post',
  'draft_post','remember','recall','finish',
  // Visibility only: execution still checks current capabilities, identity and channel.
  'external_tools','capital_execution','investment_proposal','programmable_api','partner_launch','stage_development','develop_project','read_network','build_network','finish_mission','network_work','network_care','read_network_code','change_network_code','work_wallet','trade_program',
  'manage_website','read_operational_code','change_operational_code','rollback_operational_code','run_network_program','resume_network_operation',
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

export function replyExclusion(post:any,replyAuthorIds:readonly string[]=[]):string|null {
  // An owner exception changes audience eligibility, never X's badge metadata.
  // Bind it to the fetched stable author ID, not a mutable handle or display name.
  const authorId=post?.author_id;
  const excepted=typeof authorId==='string'&&/^[1-9][0-9]{0,18}$/.test(authorId)&&
    post?.authorVerification?.id===authorId&&replyAuthorIds.includes(authorId);
  return !eligibleBadge(post?.authorVerification)&&!excepted?'verified_audience_required':conversationExclusion(post);
}

export function originalPostSchedule(startedAt:string,lastPostAt:string|null,now=Date.now(),ownerRules:readonly {id:string;enabled:boolean;text:string}[]=[]) {
  const started=Date.parse(startedAt),last=lastPostAt?Date.parse(lastPostAt):0;
  if(!Number.isFinite(started)||!Number.isFinite(last))throw Error('invalid_social_schedule');
  const nextAt=new Date(Math.max(started,last)+originalPostIntervalMs).toISOString();
  // Only authenticated configuration can advance this exact existing slot.
  // Keep nextAt unchanged: its durable action ID and uncertain-send protection
  // remain the same. Once a post completes, its new schedule consumes the grant.
  let ownerAdvance:{notBefore:string;instruction:string}|undefined;
  const rule=ownerRules.find(r=>r.id==='owner-original-post-advance'&&r.enabled);
  if(rule){
    try{
      const value=JSON.parse(rule.text);
      if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>['slot','notBefore','instruction'].includes(k))&&value.slot===nextAt&&typeof value.notBefore==='string'&&typeof value.instruction==='string'&&value.instruction.trim()){
        const permittedAt=Date.parse(value.notBefore);
        if(Number.isFinite(permittedAt)&&new Date(permittedAt).toISOString()===value.notBefore&&permittedAt<Date.parse(nextAt)&&now>=permittedAt)ownerAdvance={notBefore:value.notBefore,instruction:value.instruction};
      }
    }catch{/* Invalid owner metadata never changes the normal schedule. */}
  }
  return {due:now>=Date.parse(nextAt)||!!ownerAdvance,nextAt,intervalHours:originalPostIntervalMs/3600000,lastPostAt,...(ownerAdvance?{ownerAdvance}:{})};
}
