export function responseMetadata(response,started) {
  let receipt=null;
  const encoded=response.headers.get('payment-response');
  if(encoded)try {receipt=JSON.parse(Buffer.from(encoded,'base64').toString('utf8'));}catch {receipt={unparseable:true};}
  const headers=Object.fromEntries(['x-si-provider-family','x-si-buyer-cost-micro','x-si-truncated','x-si-adapted-params','x-request-id'].map(k=>[k,response.headers.get(k)]).filter(([,v])=>v!==null));
  return {receipt,telemetry:{latencyMs:Date.now()-started,...headers}};
}
// A still-active paid handler can finish after authorization expiry. Do not
// race it by declaring its response lost merely because the nonce was used.
export function completionTiming(isImage,purpose) {
  return !isImage&&purpose==='research'
    ? {providerMs:600000,activeMs:760000}
    : {providerMs:240000,activeMs:300000};
}
export function requestMayBeActive(row,now=Date.now()) {
  const created=Date.parse(row.created_at),declared=Date.parse(row.outcome?.activeUntil);
  const deadline=Number.isFinite(declared)&&declared>created&&declared<=created+800000?declared:created+300000;
  return ['reserved','authorizing','signed'].includes(row.status)&&now<deadline;
}
export function normalizeResponse(result,model) {
  if(result.model!==model||!Array.isArray(result.output)||!['completed','incomplete'].includes(result.status))throw new Error('invalid_model_response');
  const calls=result.output.filter(i=>i.type==='function_call');
  if(calls.some(i=>typeof i.call_id!=='string'||typeof i.name!=='string'||typeof i.arguments!=='string'))throw new Error('invalid_function_call');
  const content=result.output.filter(i=>i.type==='message').flatMap(i=>i.content??[]).filter(i=>i.type==='output_text').map(i=>i.text).join('\n');
  return {id:result.id,model:result.model,choices:[{message:{role:'assistant',content,tool_calls:calls.map(i=>({id:i.call_id,type:'function',function:{name:i.name,arguments:i.arguments}})),responseItems:result.output},finish_reason:result.status==='incomplete'?'length':calls.length?'tool_calls':'stop'}],usage:result.usage,responseStatus:result.status};
}

// Diagnose invalid provider responses without retaining text, reasoning, tool
// arguments, payment signatures, or a provider's free-form error message.
export function responseShape(result) {
  return {
    ...(typeof result?.model==='string'&&/^gpt-[a-z0-9.-]{1,80}$/.test(result.model)?{returnedModel:result.model}:{}),
    ...(['queued','in_progress','completed','incomplete','failed','cancelled'].includes(result?.status)?{responseStatus:result.status}:{}),
    ...(Array.isArray(result?.output)?{outputCount:result.output.length}:{}),
  };
}
