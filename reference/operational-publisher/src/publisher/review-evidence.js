import {createHash} from 'node:crypto';
import prompts from './review-prompts.json' with {type:'json'};
import {completionMetadata,completeModelOutput} from './model-completion.js';

const canonical=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)
  ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=()=>{throw Error('publisher_review_evidence_unavailable');};

export function verifyReviewEvidence(effect,kind,evidence) {
  if(!effect?.input||!Object.hasOwn(prompts,kind)||!evidence||evidence.version!==1||
    evidence.id!==effect.id||evidence.status!=='completed'||String(effect.amount??effect.input.quoteCeilingMicroUsdc)!==evidence.maximumMicroUsdc)fail();
  const {quoteCeilingMicroUsdc,...request}=effect.input;
  const instructionHash=hash(request.instructions??'');
  const accepted=Array.isArray(prompts[kind])?prompts[kind]:[prompts[kind]];
  if(hash(canonical(request))!==evidence.inputHash||!accepted.includes(instructionHash)||
    evidence.instructionsHash!==instructionHash)fail();
  const response=evidence.response;
  if(response?.model!==request.model||!response.choices?.[0]?.message)fail();
  const output={message:response.choices[0].message,model:response.model,receipt:response.receipt??null,completion:completionMetadata(response)};
  if(!completeModelOutput(output))fail();
  return output;
}

export async function trustedReview(effect,kind,{request=fetch,secret=process.env.PUBLISHER_REVIEW_SECRET}={}) {
  if(!/^[a-zA-Z0-9:_-]{1,160}$/.test(effect?.id??'')||typeof secret!=='string'||secret.length<32)fail();
  const {quoteCeilingMicroUsdc,...input}=effect.input;
  // Older rows predate the canonical binding. Reconstruct only the original
  // known request ordering; the payer must match its saved request hash.
  const ordered={model:input.model,provider:input.provider,reasoning:input.reasoning?{effort:input.reasoning.effort,context:input.reasoning.context}:undefined,
    max_output_tokens:input.max_output_tokens,stream:input.stream,store:input.store,instructions:input.instructions,
    input:input.input?.map(item=>({role:item.role,content:item.content}))};
  const response=await request('https://claus-ecosystem-payments.vercel.app/api/review-evidence/'+encodeURIComponent(effect.id),{
    method:'POST',body:JSON.stringify({requestBodies:[...new Set([JSON.stringify(input),JSON.stringify(ordered)])],maximumMicroUsdc:String(effect.amount??quoteCeilingMicroUsdc)}),
    headers:{authorization:'Bearer '+secret,accept:'application/json','content-type':'application/json'},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok)fail();
  const raw=await response.text();if(Buffer.byteLength(raw)>1500000)fail();
  let evidence;try{evidence=JSON.parse(raw);}catch{fail();}
  return verifyReviewEvidence(effect,kind,evidence);
}
