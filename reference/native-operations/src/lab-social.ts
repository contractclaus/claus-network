type Query=(strings:TemplateStringsArray,...values:any[])=>Promise<any[]>;

// Give new conversations a head start without letting a held historical reply
// stop independent research. The head start is bounded so an always-active
// conversation stream cannot starve the separately budgeted research worker.
export async function socialHasPriority(db:Query,reserveSeconds:number,replyAuthorIds:string[]=[]){
  const [row]=await db`SELECT
    EXISTS(SELECT 1 FROM claus_state WHERE lease_until>now()) AS busy,
    EXISTS(SELECT 1 FROM claus_lab_ideas
      WHERE visibility='public' AND status IN ('noted','queued','researching','waiting','reviewing')
        AND next_at<now()-(${reserveSeconds}*interval '1 second')
        AND (lease_until IS NULL OR lease_until<now())) AS overdue_research,
    EXISTS(SELECT 1 FROM claus_x_inbox i
      WHERE i.status='pending' AND (i.deferred_until IS NULL OR i.deferred_until<=now())
        AND GREATEST(i.observed_at,i.deferred_until)>now()-(${reserveSeconds}*interval '1 second')
        AND ((i.post->'authorVerification'->>'verified'='true'
          AND i.post->'authorVerification'->>'verified_type' IN ('blue','business'))
          OR (i.author_id=ANY(${replyAuthorIds}::text[]) AND i.post->'authorVerification'->>'id'=i.author_id))
        AND NOT EXISTS(SELECT 1 FROM claus_x_optouts o WHERE o.author_id=i.author_id AND o.enabled)
        AND NOT EXISTS(SELECT 1 FROM claus_actions a JOIN claus_x_inbox source ON source.post_id=a.input->>'replyTo'
          WHERE a.kind='x_post' AND a.status NOT IN ('completed','failed')
            AND (source.author_id=i.author_id OR source.conversation_id=i.conversation_id))
    ) AS pending`;
  return !!(row?.busy||row?.pending)&&!row?.overdue_research;
}
