import {feedbackBuildTools} from './feedback-builds.js';
import {adaptationTools} from './adaptation-service.js';
import {continuityTools} from './workspaces/continuity-service.js';
import {contributionTools} from './workspaces/review-service.js';
import {siteTools} from './site/service.js';
import {builderTools} from './builder-schema.js';
import {channelAllows} from './club-privacy.js';
import {clubTools} from './club.js';
import {researchTools,researchExtensions} from './lab-service.js';
import { once, unresolved, reconcileInference, ConfirmedFailure } from './store.js';
import type { Configuration } from './config.js';
import { definitions } from './tools.js';
import {twitterTools} from './twitter-policy.js';
import { responseInput,responseTools } from './responses.js';
import {terminalInferenceFailure} from './inference-outcome.js';
import {fencedInferenceRejection} from './inference-admission.js';

export function modelReady() {return !!(process.env.INFERENCE_URL&&process.env.INFERENCE_SECRET);}
export async function reconcilePendingInference() {
  for(const action of await unresolved()) {
    if(action.kind!=='inference')continue;
    try {
      const response=await fetch(`${process.env.INFERENCE_URL}/api/requests/${encodeURIComponent(action.id)}`,{headers:{Authorization:`Bearer ${process.env.INFERENCE_SECRET}`},redirect:'error',signal:AbortSignal.timeout(15000)});
      if(response.status===404&&Date.now()-Date.parse(action.created_at)>300000) {
        await reconcileInference(action.id,'failed',{failure:'relay_request_not_reserved',payment:'not_signed'});
      } else if(response.ok) {
        const body=await response.json();
        const modelFailure=terminalInferenceFailure(body,action.requested_model);
        if(body.status==='failed'&&['not_signed','not_settled','settled'].includes(body.outcome?.payment))await reconcileInference(action.id,'failed',body.outcome);
        else if(modelFailure)await reconcileInference(action.id,'failed',modelFailure);
        else if(body.status==='completed'&&body.response?.choices?.[0]?.message&&body.response.model===action.requested_model) {
          const r=body.response;
          await reconcileInference(action.id,'completed',{model:r.model,message:r.choices[0].message,usage:r.usage,receipt:r.receipt,telemetry:r.telemetry,responseStatus:r.responseStatus,finishReason:r.choices[0].finish_reason});
        }
      }
    } catch { /* An unavailable relay cannot authorize a new paid attempt. */ }
  }
}
export function inferenceRequest(messages:unknown[],settings:Configuration['settings'],channel:'public'|'club'='public') {
  const extensions=researchExtensions(settings.lab??{});
  const available=definitions.filter(t=>!feedbackBuildTools.has(t.function.name)||settings.builder?.enabled===true).filter(t=>!adaptationTools.has(t.function.name)||settings.adaptation?.enabled===true).filter(t=>!['build_site_feature','propose_site_feature'].includes(t.function.name)||settings.siteEditor?.autonomyEnabled===true&&settings.builder?.enabled===true).filter(t=>!continuityTools.has(t.function.name)||settings.continuity?.enabled===true&&settings.club?.enabled===true).filter(t=>!contributionTools.has(t.function.name)||settings.workspaces?.enabled===true&&settings.builder?.enabled===true).filter(t=>!siteTools.has(t.function.name)||settings.siteEditor?.enabled===true).filter(t=>!builderTools.has(t.function.name)||settings.builder?.enabled===true).filter(t=>channelAllows(t.function.name,channel)).filter(t=>!clubTools.has(t.function.name)||settings.club?.enabled===true).filter(t=>t.function.name!=='search_web'||extensions.webSearch).filter(t=>t.function.name!=='read_developments'||extensions.developments);
  return {model:settings.model,provider:settings.provider,reasoning:{effort:settings.reasoningEffort,context:'all_turns'},max_output_tokens:settings.maxOutputTokens,stream:false,store:false,instructions:messages.filter((m:any)=>m.role==='system').map((m:any)=>m.content).join('\n\n'),input:responseInput(messages),tools:responseTools(settings.role==='twitter'?available.filter(t=>twitterTools.has(t.function.name)||settings.builder?.enabled===true&&feedbackBuildTools.has(t.function.name)||settings.adaptation?.enabled===true&&adaptationTools.has(t.function.name)||settings.continuity?.enabled===true&&continuityTools.has(t.function.name)||settings.workspaces?.enabled===true&&contributionTools.has(t.function.name)||settings.siteEditor?.enabled===true&&siteTools.has(t.function.name)||settings.builder?.enabled===true&&builderTools.has(t.function.name)||settings.club?.enabled===true&&clubTools.has(t.function.name)||!!settings.lab?.enabled&&researchTools.has(t.function.name)):available.filter(t=>!researchTools.has(t.function.name)||!!settings.lab?.enabled)),tool_choice:'auto',parallel_tool_calls:false};
}
// Keep one complete review beside the fixed policy/tool envelope. This is
// bounded well below the payer's 4.2 MB request guard; payment ceilings stay there.
export const MAX_CONTEXT_BYTES=400000;
export function contextFits(messages:unknown[],settings:Configuration['settings'],channel:'public'|'club'='public',maxBytes=MAX_CONTEXT_BYTES) {const request=inferenceRequest(messages,settings,channel);return messages.length<=80&&request.input.length<=160&&Buffer.byteLength(JSON.stringify(request))<=Math.min(maxBytes,MAX_CONTEXT_BYTES);}
export async function complete(id:string,messages:unknown[],settings:Configuration['settings'],channel:'public'|'club'='public') {
  if(!modelReady()) throw new Error('inference_not_connected');
  if(!contextFits(messages,settings,channel))throw new Error('inference_context_needs_checkpoint');
  const request=inferenceRequest(messages,settings,channel);
  return completeRequest(id,request);
}
export async function completeRequest(id:string,request:any) {
  if(!modelReady())throw new Error('inference_not_connected');
  return once(id,'inference',request,async()=>{
    // Apply a lower quote ceiling only inside a newly reserved effect. Existing
    // IDs keep their original payer reservation and are never resent by once().
    const response=await fetch(`${process.env.INFERENCE_URL}/api/completion`,{method:'POST',headers:{Authorization:`Bearer ${process.env.INFERENCE_SECRET}`,'Content-Type':'application/json','Idempotency-Key':id,'X-Max-Quote-Micro-USDC':'2000000',...(process.env.INFERENCE_URL==='https://claus-ecosystem-payments.vercel.app'?{'X-Inference-Reservation':'quoted-v1'}:{})},body:JSON.stringify(request),redirect:'error',signal:AbortSignal.timeout(270000)});
    if(!response.ok) {
      const rejection=await fencedInferenceRejection(response,id,process.env.INFERENCE_URL!,process.env.INFERENCE_SECRET!);
      if(rejection)throw new ConfirmedFailure(rejection.reason,rejection.retryAt);
      throw new Error(`inference_http_${response.status}`);
    }
    const body=await response.json();
    if(!body.choices?.[0]?.message) throw new Error('invalid_inference_response');
    if(body.model!==request.model) throw new Error('model_mismatch');
    return {model:body.model,message:body.choices[0].message,usage:body.usage,receipt:body.receipt,telemetry:body.telemetry,responseStatus:body.responseStatus,finishReason:body.choices[0].finish_reason};
  });
}
