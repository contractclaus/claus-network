// The ordinary one-minute wake keeps transports and receipts responsive. It is
// not, by itself, a reason to buy another model response.
export function decisionDue(input:{continuation:boolean;networkDue:boolean;inbox:boolean;postDue:boolean;lastDecision?:{createdAt:string;revision:number}|null;configurationRevision:number;missions:{created_at:string}[]}) {
  if(input.continuation||input.networkDue||input.inbox||input.postDue)return true;
  const last=input.lastDecision;
  if(!last||last.revision!==input.configurationRevision||!Number.isFinite(Date.parse(last.createdAt)))return true;
  return input.missions.some(m=>!Number.isFinite(Date.parse(m.created_at))||Date.parse(m.created_at)>Date.parse(last.createdAt));
}
