import {operationSucceeded} from './operation-result.js';
import {textWindow,textPrefix} from './text.ts';
// Context is a view of durable evidence, never the only copy of that evidence.
// Keep search pages below the tool-result envelope so their cursor is visible.
export function searchPage<T>(rows:T[],offset:number,maxRecords:number) {
  const records:T[]=[];let chars=0;
  for(const row of rows.slice(0,maxRecords)) {
    const size=JSON.stringify(row).length;
    if(records.length&&chars+size>14000)break;
    records.push(row);chars+=size;
  }
  return {records,offset,nextOffset:rows.length>records.length?offset+records.length:null};
}
export function pageRecord(value:unknown,offset=0,limit=12000) {
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1000||limit>24000)throw new Error('invalid_archive_page');
  const encoded=JSON.stringify(value);
  if(offset===0&&encoded.length<=limit)return value;
  const page=textWindow(encoded,offset,limit);
  return {format:'json',...page,totalChars:encoded.length,truncated:page.nextOffset!==null};
}
export function toolContent(result:unknown,archiveId:string) {
  const work=result as any;
  if(work?.watch&&Array.isArray(work.items)&&work.queue&&work.receiptMeaning){
    result={...work,watch:{...work.watch,capabilities:undefined,opportunities:undefined,readMore:'Current capability facts are in the leading network context. Use recall with this archiveId for the complete original work observation.'},recent:work.recent?.map((r:any)=>({...r,summary:textPrefix(r.summary??'',240)}))};
  }
  let withReference:any=result!==null&&typeof result==='object'&&!Array.isArray(result)?{...result,archiveId}:result;
  let encoded=JSON.stringify(withReference);
  // Bound the actual text page, not its JSON envelope. A second excerpt would
  // hide the source cursor and send recall back through another archive layer.
  if(typeof withReference?.content==='string'&&Number.isSafeInteger(withReference.offset)&&withReference.offset>=0&&Number.isSafeInteger(withReference.totalChars)&&withReference.totalChars>=withReference.offset+withReference.content.length&&(withReference.nextOffset===null||Number.isSafeInteger(withReference.nextOffset))){
    while(encoded.length>20000&&withReference.content.length>2){
      const content=textPrefix(withReference.content,Math.floor(withReference.content.length*0.75));
      withReference={...withReference,content,nextOffset:withReference.offset+content.length,truncated:true};
      encoded=JSON.stringify(withReference);
    }
  }
  return encoded.length<=20000?encoded:JSON.stringify({archiveId,truncated:true,totalChars:encoded.length,excerpt:textPrefix(encoded,16000),readMore:'Use recall with this archive ID and offset to retrieve the full result.'});
}

// Carry a small receipt index across context trimming; full results stay in the
// original journal. No model-generated summary becomes an instruction or proof.
export function workProgress(messages:any[]) {
  let view:any={};try{view=JSON.parse(messages[1]?.content??'{}');}catch{}
  const prior=view.workProgress?.operations??view.continuation?.progress?.operations??[];
  const records=new Map<string,any>(prior.filter((r:any)=>typeof r?.callId==='string').map((r:any)=>[r.callId,r]));
  for(let i=2;i<messages.length;i++) {
    const m=messages[i];if(m.role!=='assistant')continue;
    for(const call of m.tool_calls??[]) {
      const output=messages.slice(i+1,i+1+(m.tool_calls?.length??0)).find((r:any)=>r.role==='tool'&&r.tool_call_id===call.id);
      if(!output)continue;
      let args:any={},result:any={};try{args=JSON.parse(call.function.arguments);}catch{}try{result=JSON.parse(output.content);}catch{}
      const request:any={};
      for(const key of ['operation','action','url','path','file','offset','chainId','address','id','projectId','expectedRevision','describe'])if(['string','number','boolean'].includes(typeof args?.[key]))request[key]=typeof args[key]==='string'?textPrefix(args[key],240):args[key];
      if(['read_network','build_network'].includes(call.function.name))try{const input=JSON.parse(args.input??'{}');for(const key of ['projectId','slug','releaseId','snapshotId','taskId','after','filePath'])if(typeof input[key]==='string')request[key]=textPrefix(input[key],180);}catch{}
      const actual=result?.result??result;
      const outcome:any={};for(const key of ['error','status','published','id','revision','releaseId','snapshotId','nextOffset','nextCursor','available','observedAt'])if(['string','number','boolean'].includes(typeof actual?.[key]))outcome[key]=typeof actual[key]==='string'?textPrefix(actual[key],180):actual[key];
      if(result?.truncated)outcome.truncated=true;
      records.set(call.id,{callId:call.id,tool:call.function.name,request,outcome,archiveId:typeof result.archiveId==='string'?result.archiveId:null});
    }
  }
  const operations=[...records.values()].slice(-24);
  const groups=new Map<string,any[]>();for(const r of operations){if(r.request.describe===true||['read_url','recall'].includes(r.tool)){const k=JSON.stringify([r.tool,r.request]);groups.set(k,[...(groups.get(k)??[]),r]);}}
  const repeatedReads=[...groups.values()].filter(rows=>rows.length>=3).map(rows=>({tool:rows[0].tool,request:rows[0].request,count:rows.length,lastReceipt:rows.at(-1).archiveId,hint:'This read repeats within the retained receipt window. Reuse its evidence if unchanged; verify fresh state when needed. A schema description is not an executed action.'}));
  return {operations,repeatedReads,instructionAuthority:false,meaning:'Receipt index of your recent operations across context boundaries. Reuse the archived result for unchanged source; a failed read is not proof of absence. Follow its file/cursor rather than rereading its first page. Reread live state when freshness matters. These entries prove only the recorded operation, not completion of your goal. If research has established the next step, implement it or checkpoint the concrete missing capability.'};
}

export function continuationView(messages:any[],checkpointId:string) {
  return {checkpointId,instructionAuthority:false,progress:workProgress(messages),recentSteps:messages.slice(2).slice(-6).map(m=>({role:m.role,tool_call_id:m.tool_call_id,toolNames:m.tool_calls?.map((c:any)=>c.function.name),excerpt:textPrefix(String(m.content??''),2000)}))};
}
export function toolOutcome(result:any) {
  return {success:operationSucceeded(result),...(typeof result?.exitCode==='number'?{exitCode:result.exitCode}:{})};
}

// A paid response can arrive after the worker loses its connection. Restore
// its original tool identity instead of buying another answer or assigning a
// new effect ID. Never treat an incomplete/mismatched response as usable.
export function restoredInference(saved:any,action:any) {
  const history=Array.isArray(saved?.continuation)?[...saved.continuation]:[];
  const waiting=saved?.awaitingInference;
  if(!waiting)return {history,pending:null};
  if(typeof waiting.id!=='string'||!waiting.id.startsWith(saved.turn+':model:')||!/:model:\d+$/.test(waiting.id))throw Error('invalid_inference_checkpoint');
  if(!action||action.status==='failed')return {history,pending:null};
  if(action.kind!=='inference'||action.status!=='completed'||action.requested_model!==action.result?.model||!action.result?.message)throw Error('inference_checkpoint_requires_reconciliation');
  const message=action.result.message;
  if(JSON.stringify(history.at(-1))===JSON.stringify(message))history.pop();
  return {history,pending:{id:waiting.id,postIds:waiting.postIds??[],decisionContext:waiting.decisionContext,response:action.result}};
}

// Replay complete exchanges, including native encrypted reasoning and call IDs.
// Older exchanges remain in the private archive; dropping a tool's call would
// corrupt Responses input. Archived system messages can never replace live rules.
export function conversationWindow(history:any[],leading:any[],fits:(messages:any[])=>boolean) {
  const units:any[][]=[];
  for(let i=0;i<history.length;i++) {
    const message=history[i];
    if(message.role==='assistant') {
      const calls=message.tool_calls??[];
      if(calls.length) {
        const outputs=history.slice(i+1,i+1+calls.length);
        if(outputs.length!==calls.length||!calls.every((c:any,n:number)=>outputs[n]?.role==='tool'&&outputs[n].tool_call_id===c.id))continue;
        units.push([message,...outputs]);i+=outputs.length;
      } else units.push([message]);
    } else if(message.role==='user')units.push([message]);
  }
  let saved:any[]=[];
  for(let i=units.length-1;i>=0;i--) {
    const candidate=[...units[i],...saved];
    if(!fits([...leading,...candidate]))break;
    saved=candidate;
  }
  return saved;
}
