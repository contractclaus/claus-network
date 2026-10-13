// Preserve ordinary HTTP errors for quick responses. During a long completion,
// JSON whitespace prevents the host's 340-second idle disconnect. The original
// handler alone owns dispatch, accounting and durable result persistence.
export async function streamCompletion(run, retain, {intervalMs=15000, maximumMs=750000, startDelayMs=1000}={}) {
  const encoder=new TextEncoder();
  let closed=false,heartbeat,deadline,output,begin,accept,grace;
  const failure=()=>Response.json({error:'payment_requires_reconciliation'},{status:502});
  const stop=()=>{clearInterval(heartbeat);clearTimeout(deadline);};
  const write=value=>{if(!closed)output.enqueue(encoder.encode(value));};
  const finish=value=>{if(closed)return;write(value);closed=true;stop();output.close();};
  const gate=new Promise(resolve=>{begin=resolve;});
  const selected=new Promise(resolve=>{accept=resolve;});
  const result=gate.then(run).then(response=>response instanceof Response?response:failure(),error=>{
    console.error('completion_handler_failed',{name:error?.name,code:typeof error?.code==='string'?error.code.slice(0,50):undefined});
    return failure();
  });
  // Retain the whole operation before dispatch, including reading its result.
  const work=result.then(async response=>{
    if(!await selected)return;
    try {const text=await response.text();JSON.parse(text);finish(text);}
    catch {finish(JSON.stringify({error:'payment_requires_reconciliation'}));}
  });
  try {retain(work);}catch {accept(false);return Response.json({error:'completion_retention_unavailable',payment:'not_signed'},{status:503});}
  begin();
  const first=await Promise.race([result,new Promise(resolve=>{grace=setTimeout(()=>resolve(null),startDelayMs);})]);
  clearTimeout(grace);
  if(first){accept(false);return first;}
  const body=new ReadableStream({
    start(controller){
      output=controller;write(' '.repeat(2048)+'\n');
      heartbeat=setInterval(()=>write(' \n'),intervalMs);
      deadline=setTimeout(()=>finish(JSON.stringify({error:'payment_requires_reconciliation'})),maximumMs);
    },
    // Reader loss stops delivery only. The retained original job still saves.
    cancel(){closed=true;stop();}
  });
  accept(true);
  return new Response(body,{headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, no-transform','X-Claus-Completion-Stream':'1'}});
}
