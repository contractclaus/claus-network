import {validateChallenge} from './policy.js';

// Older exchanges remain in the agent's durable action/journal archive. Only
// recognize complete native tool exchanges, so no call loses its result or
// encrypted reasoning is detached from the exchange that produced it.
export function recentToolInput(input,limit) {
  if(!Array.isArray(input)||input[0]?.role!=='user')return null;
  const units=[];
  for(let start=1;start<input.length;) {
    let cursor=start;
    while(input[cursor]?.type==='reasoning'||input[cursor]?.type==='message'&&input[cursor]?.role==='assistant')cursor++;
    const calls=[];
    while(input[cursor]?.type==='function_call')calls.push(input[cursor++].call_id);
    if(!calls.length||calls.some(id=>typeof id!=='string')||new Set(calls).size!==calls.length)return null;
    for(const id of calls) {
      if(input[cursor]?.type!=='function_call_output'||input[cursor].call_id!==id)return null;
      cursor++;
    }
    units.push(input.slice(start,cursor));
    start=cursor;
  }
  return units.length>limit?[input[0],...units.slice(-limit).flat()]:null;
}

// Negotiate unsigned quotes only. Keep the model and reasoning setting. Try
// smaller output reservations before retaining just the latest full exchanges.
export async function quoteWithinBudget(request,{maximum,schemes,endpoint,fetchQuote,allowSmallerOutput=false}) {
  let effective=request;
  for(;;) {
    const challenge=await fetchQuote(effective);
    try {
      const requirement=validateChallenge(challenge,maximum,schemes,endpoint);
      return {request:effective,challenge,requirement};
    } catch(error) {
      if(error.message!=='quote_refused'||!allowSmallerOutput)throw error;
      const next=effective.max_output_tokens>4096?4096:effective.max_output_tokens>2048?2048:null;
      if(next!==null) {
        effective={...effective,max_output_tokens:next};
      } else {
        const input=recentToolInput(effective.input,2)??recentToolInput(effective.input,1);
        if(!input)throw error;
        effective={...effective,input};
      }
    }
  }
}
