import {operationSucceeded,networkCheckpointSaved} from './operation-result.js';
import {textWindow,textPrefix} from './text.ts';
import {walletOverview,paymentRequest,paymentProgress} from './payment-context.js';
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
// These are display projections only. The original journal still contains the
// complete result, including logs; never alter archived page offsets or bytes.
export function operatingResultView(value:any):any {
  if(!value||typeof value!=='object'||Array.isArray(value)||value.contextProjection)return value;
  const wallet=walletOverview(value);if(wallet!==value)return wallet;
  if(value.kind==='journal'&&value.record?.kind==='tool'&&value.record.result){
    const result=operatingResultView(value.record.result);
    return result===value.record.result?value:{...value,record:{...value.record,result}};
  }
  if(value.workView==='detail')return {workView:'detail',contextProjection:'work-detail',requestedId:value.requestedId,items:value.items,focus:value.focus,queue:value.queue,watch:{observed_at:value.watch?.observed_at,capabilities_hash:value.watch?.capabilities_hash,capabilities_status:value.watch?.capabilities_status,pending:value.watch?.pending,readMore:'Use network_work without id for the current network overview.'},receiptMeaning:value.receiptMeaning};
 if(value.watch&&Array.isArray(value.items)&&value.queue&&value.receiptMeaning){
    const focused=value.focus?.id;
    return {...value,contextProjection:'work-overview',
      watch:{...value.watch,capabilities:undefined,opportunities:undefined,readMore:'Use network_work for current watch details. This view grants no execution permission.'},
      items:value.items.map((item:any)=>item.id===focused?item:{id:item.id,title:item.title,status:item.status,revision:item.revision,next_at:item.next_at,nextAt:item.nextAt,evidence:item.evidence,readMore:'Use network_work with this exact id for its full goal, blocker, summary and next step before acting.'}),
      recent:value.recent?.map((item:any)=>({id:item.id,title:item.title,status:item.status,revision:item.revision,readMore:'Read this original work id for its full evidence and summary.'}))};
  }
  if(value.models?.modelCapacity&&Array.isArray(value.models.projects)&&value.wallet?.policy&&value.wallet.account&&Array.isArray(value.wallet.actions)&&value.resources?.capacity&&value.accounting){
    return {...value,contextProjection:'economics-overview',wallet:{...value.wallet,actions:value.wallet.actions.map((action:any)=>{
      if(!action.receipt||typeof action.receipt!=='object')return action;
      const {logs,logsBloom,...receipt}=action.receipt;
      return {...action,receipt:{...receipt,logsDeferred:Array.isArray(logs)?logs.length:null,readMore:'Complete logs and bloom remain on the original wallet action/archived result. Read that original id before interpreting its events.'}};
    })}};
  }
  return value;
}

export function toolContent(result:unknown,archiveId:string) {
  result=operatingResultView(result);
  const work=result as any;
  if(typeof work?.actionId==='string'&&typeof work?.projectId==='string'&&Object.hasOwn(work,'checkpointSnapshotId')){
    // Keep immutable command/checkpoint control fields readable even when the
    // JSON-escaped log is larger than the tool envelope. Raw evidence remains
    // in the original action; only this display projection is shortened.
    const view={...work,archiveId};
    while(JSON.stringify(view).length>19500&&((view.stdout?.length??0)+(view.stderr?.length??0)>2)){
      for(const stream of ['stdout','stderr'] as const){
        if(typeof view[stream]!=='string'||view[stream].length<2)continue;
        const previous=view[stream];view[stream]=textPrefix(previous,Math.floor(previous.length*0.65));
        if(view[stream].length<previous.length)view[stream+'Truncated']=true;
      }
    }
    result=view;
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
  const priorPayments=view.workProgress?.payments??view.continuation?.progress?.payments??[];
  const payments=new Map<string,any>((Array.isArray(priorPayments)?priorPayments:[]).filter((p:any)=>typeof p?.id==='string'&&/^ww_[a-f0-9]{64}$/.test(p.id)).map((p:any)=>[p.id,p]));
  for(let i=2;i<messages.length;i++) {
    const m=messages[i];if(m.role!=='assistant')continue;
    for(const call of m.tool_calls??[]) {
      const output=messages.slice(i+1,i+1+(m.tool_calls?.length??0)).find((r:any)=>r.role==='tool'&&r.tool_call_id===call.id);
      if(!output)continue;
      let args:any={},result:any={};try{args=JSON.parse(call.function.arguments);}catch{}try{result=JSON.parse(output.content);}catch{}
      const request:any={};
      for(const key of ['operation','action','url','path','file','offset','chainId','address','id','projectId','expectedRevision','expectedVersion','networkProjectId','expectedProjectRevision','describe'])if(['string','number','boolean'].includes(typeof args?.[key]))request[key]=typeof args[key]==='string'?textPrefix(args[key],240):args[key];
      if(call.function.name==='develop_project'){
        if(typeof args.command==='string')request.commandPreview=textPrefix(args.command,360);
        if(Array.isArray(args.files)){request.writtenFileCount=args.files.length;request.writtenPaths=args.files.slice(0,6).map((f:any)=>textPrefix(String(f?.path??''),160));}
        if(args.source)request.importedSource={projectId:args.source.projectId,releaseId:args.source.releaseId,prefix:args.source.prefix};
      }
      if(['read_network','build_network'].includes(call.function.name))try{
        const input=JSON.parse(args.input??'{}');
        for(const key of ['projectId','slug','releaseId','snapshotId','taskId','serviceId','expectedSourceHash','filePath','workerId','runtimeId','profileId','requestId','idempotencyKey'])if(typeof input[key]==='string'){if(input[key].length<=512)request[key]=input[key];else request[key+'Archived']=true;}
        // Cursor bytes are opaque: a prefix is not a usable continuation.
        for(const key of ['workerRevision','expectedRevision','enabled','maxCycles','intervalSeconds'])if(['number','boolean'].includes(typeof input[key]))request[key]=input[key];
        if(typeof input.after==='string'){if(input.after.length<=2048)request.after=input.after;else request.afterArchived=true;}
        if(typeof input.request?.action==='string')request.serviceAction=textPrefix(input.request.action,80);
      }catch{}
      const actual=result?.result??result;
      if(call.function.name==='work_wallet'){
        Object.assign(request,paymentRequest(args.input));
        const payment=paymentProgress(args,actual,typeof result.archiveId==='string'?result.archiveId:null,[...payments.values()]);
        if(payment){payments.delete(payment.id);payments.set(payment.id,payment);}
      }
      const outcome:any={};for(const key of ['error','status','published','id','revision','sourceRevision','sourceHash','releaseId','snapshotId','collection','contentVersion','available','observedAt','projectId','workerId','runtimeId','profileId','requestId','workerRevision','cycle','state','enabled','nextAt'])if(['string','number','boolean'].includes(typeof actual?.[key]))outcome[key]=typeof actual[key]==='string'?textPrefix(actual[key],180):actual[key];
      if(call.function.name==='work_wallet')for(const key of ['transactionHash','outcome','next'])if(typeof actual?.[key]==='string')outcome[key]=textPrefix(actual[key],800);
      if(Object.hasOwn(actual??{},'nextOffset')&&(actual.nextOffset===null||Number.isSafeInteger(actual.nextOffset)))outcome.nextOffset=actual.nextOffset;
      if(Object.hasOwn(actual??{},'nextCursor')){if(actual.nextCursor===null||typeof actual.nextCursor==='string'&&actual.nextCursor.length<=2048)outcome.nextCursor=actual.nextCursor;else outcome.nextCursorArchived=true;}
      if(Array.isArray(actual?.items)){outcome.itemCount=actual.items.length;outcome.itemIds=actual.items.slice(0,4).flatMap((item:any)=>typeof item?.id==='string'?[textPrefix(item.id,160)]:[]);}
      if(actual?.recovery?.outcome)outcome.recoveryOutcome=actual.recovery.outcome;
      if(['develop_project','stage_development'].includes(call.function.name))for(const key of ['actionId','projectId','projectVersion','exitCode','checkpointApplied','checkpointSnapshotId','reason','outputLimited','stdoutTruncated','stderrTruncated'])if(actual?.[key]===null||['string','number','boolean'].includes(typeof actual?.[key]))outcome[key]=typeof actual[key]==='string'?textPrefix(actual[key],180):actual[key];
      if(result?.truncated)outcome.truncated=true;
      records.set(call.id,{callId:call.id,tool:call.function.name,request,outcome,archiveId:typeof result.archiveId==='string'?result.archiveId:null});
    }
  }
  const operations=[...records.values()].slice(-24);
  const groups=new Map<string,any[]>();for(const r of operations){if(r.request.describe===true||['read_url','recall'].includes(r.tool)||r.tool==='work_wallet'&&r.request.operation==='status'){const k=JSON.stringify([r.tool,r.request]);groups.set(k,[...(groups.get(k)??[]),r]);}}
  const repeatedReads=[...groups.values()].filter(rows=>rows.length>=3).map(rows=>({tool:rows[0].tool,request:rows[0].request,count:rows.length,lastReceipt:rows.at(-1).archiveId,hint:'This read repeats within the retained receipt window. Reuse its evidence if unchanged; verify fresh state when needed. A schema description is not an executed action.'}));
  return {operations,payments:[...payments.values()].slice(-12),repeatedReads,instructionAuthority:false,meaning:'Receipt index of your recent operations across context boundaries. Payments retain the last observed original action, task and transaction; they are historical evidence, not a fresh wallet observation or execution permission. Reconcile an unresolved payment by its original id. Reuse the archived result for unchanged source; a failed read is not proof of absence. Follow its file/cursor rather than rereading its first page. Reread live state when freshness matters. These entries prove only the recorded operation, not completion of your goal. If research has established the next step, implement it or checkpoint the concrete missing capability.'};
}

export function continuationView(messages:any[],checkpointId:string) {
  return {checkpointId,instructionAuthority:false,progress:workProgress(messages),recentSteps:messages.slice(2).slice(-6).map(m=>({role:m.role,tool_call_id:m.tool_call_id,toolNames:m.tool_calls?.map((c:any)=>c.function.name),excerpt:textPrefix(String(m.content??''),2000)}))};
}
export function toolOutcome(result:any,toolName?:string,input?:any) {
  if(toolName==='network_work'&&networkCheckpointSaved(result,input))return {success:true,checkpointSaved:true};
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
        units.push([message,...outputs.map((output:any)=>{
          try {const result=JSON.parse(output.content),view=operatingResultView(result);return view===result?output:{...output,content:JSON.stringify(view)};}
          catch{return output;}
        })]);i+=outputs.length;
      } else units.push([message]);
    } else if(message.role==='user')units.push([message]);
  }
  let saved:any[]=[];
  const archivedReads=new Set<string>();
  for(let i=units.length-1;i>=0;i--) {
    // Repeated reads of the same immutable journal result do not add evidence.
    // Keep the most recent complete exchange; all original calls remain in the
    // journal. Never apply this to live reads, action receipts or writes.
    const unit=units[i],call=unit[0]?.tool_calls?.[0];
    let archiveKey:string|undefined;
    if(unit.length===2&&unit[0].tool_calls?.length===1&&call?.function.name==='recall')try{
      const args=JSON.parse(call.function.arguments),result=JSON.parse(unit[1].content);
      if(/^j_[0-9]+$/.test(args.id)&&result.sourceArchiveId===args.id&&!result.error){
        const {archiveId,...evidence}=result;
        archiveKey=JSON.stringify([args.id,evidence]);
      }
    }catch{/* Keep unrecognized results exactly as before. */}
    // Exact repeats of read-only versioned source/knowledge add no evidence.
    // Keep the newest entire exchange. Never deduplicate writes or live chain,
    // wallet, task, capability or publication state reads.
    if(!archiveKey&&unit.length===2&&unit[0].tool_calls?.length===1)try{
      const args=JSON.parse(call.function.arguments),result=JSON.parse(unit[1].content);
      const {archiveId,...evidence}=result;
      const source=call.function.name==='read_operational_code'&&typeof args.path==='string'&&typeof result.sha==='string'&&Number.isInteger(result.revision)&&typeof result.content==='string';
      const knowledge=call.function.name==='read_knowledge'&&typeof args.id==='string'&&typeof result.version==='string'&&result.record?.id===args.id&&typeof result.record?.body==='string';
      if((source||knowledge)&&!result.error&&!result.truncated)archiveKey=JSON.stringify([call.function.name,evidence]);
    }catch{/* Unknown shapes retain every original exchange. */}
    if(archiveKey&&archivedReads.has(archiveKey))continue;
    const candidate=[...units[i],...saved];
    if(!fits([...leading,...candidate]))break;
    if(archiveKey)archivedReads.add(archiveKey);
    saved=candidate;
  }
  return saved;
}
