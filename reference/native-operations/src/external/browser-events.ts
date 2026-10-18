import type {Page,ConsoleMessage,Request,Response} from 'playwright-core';

// Diagnostic text is untrusted. Do not evaluate console arguments or collect
// request headers, cookies, bodies, page variables or form contents.
export function diagnosticRedactor(values:string[]=[]){
 const secrets=[...new Set(values.filter(v=>typeof v==='string'&&v.length>=4))].sort((a,b)=>b.length-a.length);
 return (value:unknown)=>{
  if(typeof value!=='string')return '';
  if(value.length>32768)return '[oversized diagnostic omitted]';
  let s=value;
  for(const secret of secrets){s=s.split(secret).join('[redacted]');const encoded=encodeURIComponent(secret);if(encoded!==secret)s=s.split(encoded).join('[redacted]');}
  s=s.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,'[private key redacted]')
   .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9_~+\/.=\-]+/gi,'[authorization redacted]')
   .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[token redacted]')
   .replace(/\b(?:gh[pousr]_|github_pat_|sk_live_|sk_test_|sk-proj-|sk-)[A-Za-z0-9_-]{8,}\b/g,'[key redacted]')
   .replace(/(["']?(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|password|secret|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,'$1[redacted]')
   .replace(/\b(?:https?|wss?|postgres(?:ql)?|redis(?:s)?):\/\/[^\s<>"']+/gi,raw=>{
    try{const u=new URL(raw);return ['http:','https:'].includes(u.protocol)?u.origin+u.pathname:'[private connection URL]';}catch{return '[URL omitted]';}
   });
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').slice(0,1400);
 };
}

export function captureBrowserEvents(page:Page,privateValues:string[]=[],env:NodeJS.ProcessEnv=process.env,now=Date.now){
 const redact=diagnosticRedactor([...privateValues,...Object.entries(env).filter(([k])=>/TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|DATABASE_URL|CONNECTION_STRING/i.test(k)).map(([,v])=>v??'')]);
 const startedAt=now(),events:Record<string,unknown>[]=[];let chars=0,dropped=0,stopped=false;
 const add=(kind:string,data:Record<string,unknown>)=>{
  if(stopped)return;
  const event={kind,at:new Date(now()).toISOString(),...data},size=JSON.stringify(event).length;
  if(events.length>=50||chars+size>12000){dropped++;return;}chars+=size;events.push(event);
 };
 const guarded=(fn:(arg:any)=>void)=>(arg:any)=>{try{fn(arg);}catch{dropped++;}};
 const consoleEvent=guarded((m:ConsoleMessage)=>{if(!['error','warning','assert'].includes(m.type()))return;const p=m.location();add('console',{level:m.type(),text:redact(m.text()),location:{url:redact(p.url),line:p.lineNumber,column:p.columnNumber}});});
 const pageError=guarded((e:Error)=>add('pageerror',{text:redact(e.stack??e.message)}));
 const requestFailed=guarded((r:Request)=>add('requestfailed',{url:redact(r.url()),method:r.method(),resourceType:r.resourceType(),error:redact(r.failure()?.errorText??'unknown')}));
 const responseError=guarded((r:Response)=>{if(r.status()>=400)add('http_error',{url:redact(r.url()),status:r.status(),resourceType:r.request().resourceType()});});
 const crash=()=>add('crash',{});
 page.on('console',consoleEvent);page.on('pageerror',pageError);page.on('requestfailed',requestFailed);page.on('response',responseError);page.on('crash',crash);
 return {
  snapshot:()=>({startedAt:new Date(startedAt).toISOString(),observedAt:new Date(now()).toISOString(),events:[...events],dropped,scope:'Events observed on this page during this connection only; earlier session events and other pages are unavailable.',filtering:'Known credential values, entered values and common secret formats are redacted; URLs omit credentials, query and fragment. No console object evaluation or network payload capture.',instructionAuthority:false}),
  stop:()=>{stopped=true;page.off('console',consoleEvent);page.off('pageerror',pageError);page.off('requestfailed',requestFailed);page.off('response',responseError);page.off('crash',crash);}
 };
}
