import {chromium} from 'playwright-core';
import {browserUrl,providerJson,ProviderFailure,type ExternalPolicy} from './providers.js';

export function workflowInput(policy:ExternalPolicy,input:any){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['url','contextId','steps'].includes(k))||!Array.isArray(input.steps)||input.steps.length>12)throw new ProviderFailure('browser_workflow_invalid',true);
 browserUrl(policy,input.url);
 if(input.contextId!==undefined&&!/^[a-zA-Z0-9-]{8,100}$/.test(input.contextId))throw new ProviderFailure('browser_context_invalid',true);
 for(const s of input.steps){
  if(!s||typeof s!=='object'||!['read','navigate','click','fill'].includes(s.action)||Object.keys(s).some(k=>!['action','url','target','value'].includes(k)))throw new ProviderFailure('browser_step_invalid',true);
  if(s.action==='navigate')browserUrl(policy,s.url);
  if(['click','fill'].includes(s.action)){
   const t=s.target;if(!t||typeof t!=='object'||Object.keys(t).some(k=>!['role','name','label'].includes(k))||!(typeof t.role==='string'&&typeof t.name==='string'||typeof t.label==='string')||JSON.stringify(t).length>1000)throw new ProviderFailure('browser_target_invalid',true);
  }
  if(s.action==='fill'&&(typeof s.value!=='string'||s.value.length>8000))throw new ProviderFailure('browser_value_invalid',true);
 }
 return input;
}
export async function browserContext(policy:ExternalPolicy,original:string){
 if(!policy.browser||!process.env.BROWSERBASE_API_KEY)throw new ProviderFailure('browser_not_connected',true);
 const r=await providerJson('https://api.browserbase.com/v1/contexts',{method:'POST',headers:{'X-BB-API-Key':process.env.BROWSERBASE_API_KEY,'content-type':'application/json'},body:JSON.stringify({projectId:policy.browser.projectId})},false);
 if(typeof r.id!=='string')throw new ProviderFailure('browser_context_outcome_unknown',false);
 return {contextId:r.id,original,retention:'provider-managed-encrypted-context',cookiesExposed:false};
}
export async function browserWorkflow(policy:ExternalPolicy,input:any,original:string){
 const plan=workflowInput(policy,input),spec=policy.browser!,key=process.env.BROWSERBASE_API_KEY;
 if(!key)throw new ProviderFailure('browser_not_connected',true);
 const headers={'X-BB-API-Key':key,'content-type':'application/json'};
 const session=await providerJson('https://api.browserbase.com/v1/sessions',{method:'POST',headers,body:JSON.stringify({projectId:spec.projectId,timeout:spec.seconds,keepAlive:false,userMetadata:{clausAction:original},browserSettings:{solveCaptchas:false,recordSession:false,logSession:false,ignoreCertificateErrors:false,...(plan.contextId?{context:{id:plan.contextId,persist:true}}:{})}})},false);
 const connect=new URL(session.connectUrl??'https://invalid');
 if(typeof session.id!=='string'||session.projectId!==spec.projectId||connect.protocol!=='wss:'||!(connect.hostname==='connect.browserbase.com'||connect.hostname.endsWith('.browserbase.com')))throw new ProviderFailure('browser_connection_invalid',false);
 let browser:Awaited<ReturnType<typeof chromium.connectOverCDP>>|undefined;
 const observations:any[]=[];let completedSteps=0,failedStep:number|null=null,failurePhase='connection',outcome:any;
 try{
  browser=await chromium.connectOverCDP(session.connectUrl,{timeout:15000});
  const context=browser.contexts()[0];if(!context)throw new ProviderFailure('browser_context_missing',true);
  await context.route('**/*',async route=>{
   const req=route.request();if(req.isNavigationRequest()){try{browserUrl(policy,req.url());}catch{await route.abort();return;}}
   await route.continue();
  });
  const page=context.pages()[0]??await context.newPage();page.setDefaultTimeout(5000);
  const observe=async()=>{browserUrl(policy,page.url());return {url:page.url(),title:await page.title(),text:(await page.locator('body').innerText()).slice(0,10000),controls:await page.locator('a,button,input,textarea,select,[role="button"]').evaluateAll(nodes=>nodes.slice(0,100).map((n:any)=>({tag:n.tagName.toLowerCase(),role:n.getAttribute('role'),name:(n.innerText||n.getAttribute('aria-label')||n.labels?.[0]?.innerText||n.getAttribute('placeholder')||'').slice(0,180),type:n.type??null})))}};
  failurePhase='initial_navigation';await page.goto(plan.url,{waitUntil:'domcontentloaded',timeout:15000});
  failurePhase='initial_observation';observations.push(await observe());
  for(const [stepIndex,step] of plan.steps.entries()){
   failedStep=stepIndex;failurePhase='action';
   browserUrl(policy,page.url());
   if(step.action==='navigate')await page.goto(step.url,{waitUntil:'domcontentloaded',timeout:15000});
   if(step.action==='click'||step.action==='fill'){
    const t=step.target,loc=typeof t.label==='string'?page.getByLabel(t.label,{exact:true}):page.getByRole(t.role,{name:t.name,exact:true});
    if(await loc.count()!==1||!await loc.isVisible())throw new ProviderFailure('browser_target_not_unique',true);
    if(step.action==='fill'){
     if((await loc.getAttribute('type'))==='password')throw new ProviderFailure('browser_secret_entry_denied',true);
     await loc.fill(step.value);
    }else await loc.click();
   }
   completedSteps++;failurePhase='observation';observations.push(await observe());
  }
  outcome={state:'completed',sessionId:session.id,contextId:plan.contextId??null,completedSteps,observations,instructionAuthority:false};
 }catch(error){
  // Earlier clicks may have changed the remote app. Preserve observations and
  // stop; never repeat the whole sequence after a later timeout.
  outcome={state:'stopped',sessionId:session.id,contextId:plan.contextId??null,completedSteps,observations,failedStep,failurePhase,error:error instanceof ProviderFailure?error.message:'browser_step_outcome_unknown',retryWholeWorkflow:false,instructionAuthority:false};
 }
 if(browser)await browser.close().catch(()=>{});
 let sessionRelease:any={state:'unknown',sessionId:session.id};
 try{
  const released=await providerJson('https://api.browserbase.com/v1/sessions/'+session.id,{method:'POST',headers,body:JSON.stringify({status:'REQUEST_RELEASE'})},false);
  if(released.id===session.id&&released.projectId===spec.projectId){
   const terminal=['COMPLETED','ERROR','TIMED_OUT'].includes(released.status);
   sessionRelease={state:terminal?'confirmed':'requested',sessionId:session.id,providerStatus:released.status??null};
  }
 }catch{}
 return {...outcome,closedAfterWork:sessionRelease.state==='confirmed',sessionRelease,retryWholeWorkflow:false};
}

